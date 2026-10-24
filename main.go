// qrcpy: a peer-to-peer shared clipboard. The server only hands out join codes
// and relays WebRTC signaling; pasted text and files travel directly between
// browsers over data channels.
package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	qrcode "github.com/skip2/go-qrcode"
)

//go:embed web
var webFS embed.FS

var (
	addr        = flag.String("addr", ":8080", "listen address")
	codeTTL     = flag.Duration("code-ttl", 60*time.Second, "how long a join code stays valid")
	stunURL     = flag.String("stun", "stun:stun.l.google.com:19302", "STUN server URL (empty to disable)")
	turnURL     = flag.String("turn", "", "optional TURN server URL, e.g. turn:turn.example.com:3478")
	turnUser    = flag.String("turn-user", "", "TURN username")
	turnPass    = flag.String("turn-pass", "", "TURN credential")
	behindProxy = flag.Bool("behind-proxy", false, "trust X-Forwarded-For for rate limiting")
	publicURL   = flag.String("public-url", "", "address other devices use to reach this server, put in QR codes (e.g. http://192.168.1.20:8080)")
	healthcheck = flag.Bool("healthcheck", false, "check that a server on -addr responds, then exit")
)

// inContainer reports whether we run in Docker, where the interfaces we see
// are the container's, not the host's.
var inContainer = func() bool {
	_, err := os.Stat("/.dockerenv")
	return err == nil
}()

const (
	maxFailures   = 10
	failureWindow = 10 * time.Minute
	writeWait     = 10 * time.Second
	pongWait      = 60 * time.Second
	pingEvery     = 25 * time.Second
	maxMsgSize    = 64 << 10
	// codeGrace keeps a code working briefly after it is replaced on schedule,
	// so someone halfway through typing it isn't turned away.
	codeGrace = 15 * time.Second
)

var idPattern = regexp.MustCompile(`^[a-f0-9]{16,64}$`)

type client struct {
	id     string
	name   string
	ip     string
	conn   *websocket.Conn
	send   chan []byte
	room   *room
	closed bool
}

type room struct {
	id       string
	code     string
	exp      time.Time
	prevCode string
	prevExp  time.Time
	timer    *time.Timer
	members  map[string]*client
}

type failWindow struct {
	count int
	start time.Time
}

type hub struct {
	mu      sync.Mutex
	rooms   map[string]*room
	codes   map[string]*room
	clients map[string]*client
	fails   map[string]*failWindow
	ice     []iceServer
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type peerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// newCode returns a 6-digit code not currently assigned to any room.
// Caller must hold h.mu.
func (h *hub) newCode() string {
	for {
		n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
		if err != nil {
			panic(err)
		}
		code := fmt.Sprintf("%06d", n.Int64())
		if _, taken := h.codes[code]; !taken {
			return code
		}
	}
}

// rotate issues a fresh code for the room. With keepPrev the outgoing code
// stays valid for codeGrace; otherwise it stops working at once.
// Caller must hold h.mu.
func (h *hub) rotate(r *room, keepPrev bool) {
	if r.prevCode != "" {
		delete(h.codes, r.prevCode)
		r.prevCode = ""
	}
	if r.code != "" {
		if keepPrev {
			r.prevCode, r.prevExp = r.code, time.Now().Add(codeGrace)
		} else {
			delete(h.codes, r.code)
		}
	}
	if r.timer != nil {
		r.timer.Stop()
	}
	r.code = h.newCode()
	r.exp = time.Now().Add(*codeTTL)
	h.codes[r.code] = r
	r.timer = time.AfterFunc(*codeTTL, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.rooms[r.id] == r {
			h.rotate(r, true)
		}
	})
	h.broadcast(r, "", map[string]any{"t": "code", "code": r.code, "left": time.Until(r.exp).Milliseconds()})
}

// Caller must hold h.mu.
func (h *hub) createRoom(id string) *room {
	if !idPattern.MatchString(id) {
		id = randomHex(16)
	}
	r := &room{id: id, members: map[string]*client{}}
	h.rooms[id] = r
	h.rotate(r, false)
	return r
}

// Caller must hold h.mu.
func (h *hub) addToRoom(c *client, r *room) {
	h.broadcast(r, "", map[string]any{"t": "peer-join", "id": c.id, "name": c.name})
	r.members[c.id] = c
	c.room = r
}

// Caller must hold h.mu.
func (h *hub) leaveRoom(c *client) {
	r := c.room
	if r == nil {
		return
	}
	c.room = nil
	delete(r.members, c.id)
	if len(r.members) == 0 {
		r.timer.Stop()
		delete(h.codes, r.code)
		delete(h.codes, r.prevCode)
		delete(h.rooms, r.id)
		return
	}
	h.broadcast(r, "", map[string]any{"t": "peer-leave", "id": c.id})
}

// Caller must hold h.mu.
func (h *hub) peersOf(c *client) []peerInfo {
	peers := []peerInfo{}
	for _, m := range c.room.members {
		if m != c {
			peers = append(peers, peerInfo{m.id, m.name})
		}
	}
	return peers
}

// Caller must hold h.mu.
func (h *hub) broadcast(r *room, except string, msg any) {
	for id, m := range r.members {
		if id != except {
			h.sendTo(m, msg)
		}
	}
}

// Caller must hold h.mu.
func (h *hub) sendTo(c *client, msg any) {
	if c.closed {
		return
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	select {
	case c.send <- b:
	default:
		// Slow consumer: drop it rather than block the hub.
		h.drop(c)
	}
}

// Caller must hold h.mu.
func (h *hub) drop(c *client) {
	if c.closed {
		return
	}
	c.closed = true
	if h.clients[c.id] == c {
		delete(h.clients, c.id)
	}
	h.leaveRoom(c)
	close(c.send)
}

// allowAttempt reports whether ip may try another join code. Caller must hold h.mu.
func (h *hub) allowAttempt(ip string) bool {
	f := h.fails[ip]
	if f == nil || time.Since(f.start) > failureWindow {
		return true
	}
	return f.count < maxFailures
}

// Caller must hold h.mu.
func (h *hub) recordFailure(ip string) {
	f := h.fails[ip]
	if f == nil || time.Since(f.start) > failureWindow {
		f = &failWindow{start: time.Now()}
		h.fails[ip] = f
	}
	f.count++
}

func (h *hub) pruneFailures() {
	for range time.Tick(time.Minute) {
		h.mu.Lock()
		for ip, f := range h.fails {
			if time.Since(f.start) > failureWindow {
				delete(h.fails, ip)
			}
		}
		h.mu.Unlock()
	}
}

type inbound struct {
	T    string          `json:"t"`
	Code string          `json:"code"`
	Name string          `json:"name"`
	To   string          `json:"to"`
	Data json.RawMessage `json:"data"`
}

func (h *hub) handle(c *client, msg inbound) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.closed {
		return
	}
	switch msg.T {
	case "join":
		if !h.allowAttempt(c.ip) {
			h.sendTo(c, map[string]any{"t": "join-error", "msg": "Too many wrong codes. Wait a few minutes and try again."})
			return
		}
		code := strings.TrimSpace(msg.Code)
		r, ok := h.codes[code]
		if ok {
			now := time.Now()
			ok = (code == r.code && now.Before(r.exp)) || (code == r.prevCode && now.Before(r.prevExp))
		}
		if !ok {
			h.recordFailure(c.ip)
			h.sendTo(c, map[string]any{"t": "join-error", "msg": "That code doesn't match an open session. Check the other screen for the current code."})
			return
		}
		if r == c.room {
			h.sendTo(c, map[string]any{"t": "join-error", "msg": "That's this device's own code. Enter it on the other device instead."})
			return
		}
		h.leaveRoom(c)
		// Codes are single use: once someone joins, onlookers can't reuse it,
		// and the grace code goes too.
		h.rotate(r, false)
		h.addToRoom(c, r)
		h.sendTo(c, map[string]any{
			"t": "joined", "room": r.id, "code": r.code, "left": time.Until(r.exp).Milliseconds(), "peers": h.peersOf(c),
		})
	case "name":
		if name := cleanName(msg.Name); name != "" {
			c.name = name
		}
	case "signal":
		if c.room == nil {
			return
		}
		if to, ok := c.room.members[msg.To]; ok && to != c {
			h.sendTo(to, map[string]any{"t": "signal", "from": c.id, "data": msg.Data})
		}
	}
}

// cleanName trims a device name to at most 40 characters.
func cleanName(s string) string {
	name := []rune(strings.TrimSpace(s))
	if len(name) > 40 {
		name = name[:40]
	}
	return string(name)
}

var upgrader = websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096}

func clientIP(r *http.Request) string {
	if *behindProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			return strings.TrimSpace(strings.Split(xff, ",")[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (h *hub) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	q := r.URL.Query()
	id := q.Get("cid")
	if !idPattern.MatchString(id) {
		id = randomHex(8)
	}
	name := cleanName(q.Get("name"))
	if name == "" {
		name = "A device"
	}
	c := &client{id: id, name: name, ip: clientIP(r), conn: conn, send: make(chan []byte, 256)}

	h.mu.Lock()
	if old, ok := h.clients[id]; ok {
		h.drop(old)
	}
	h.clients[id] = c
	rm, ok := h.rooms[q.Get("room")]
	if !ok {
		rm = h.createRoom(q.Get("room"))
	}
	h.addToRoom(c, rm)
	h.sendTo(c, map[string]any{
		"t": "hello", "id": c.id, "room": rm.id, "code": rm.code, "left": time.Until(rm.exp).Milliseconds(),
		"peers": h.peersOf(c), "ice": h.ice, "lan": lanAddrs(), "origin": strings.TrimRight(*publicURL, "/"),
		"ttl": codeTTL.Milliseconds(),
	})
	h.mu.Unlock()

	go c.writePump()
	c.readPump(h)
}

func (c *client) readPump(h *hub) {
	defer func() {
		h.mu.Lock()
		h.drop(c)
		h.mu.Unlock()
		c.conn.Close()
	}()
	c.conn.SetReadLimit(maxMsgSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		var msg inbound
		if err := c.conn.ReadJSON(&msg); err != nil {
			return
		}
		h.handle(c, msg)
	}
}

func (c *client) writePump() {
	ping := time.NewTicker(pingEvery)
	defer func() {
		ping.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case b, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, b); err != nil {
				return
			}
		case <-ping.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// serveQR renders the d parameter as a QR code SVG.
func serveQR(w http.ResponseWriter, r *http.Request) {
	data := r.URL.Query().Get("d")
	if data == "" || len(data) > 512 {
		http.Error(w, "bad data", http.StatusBadRequest)
		return
	}
	q, err := qrcode.New(data, qrcode.Medium)
	if err != nil {
		http.Error(w, "bad data", http.StatusBadRequest)
		return
	}
	q.DisableBorder = true
	bm := q.Bitmap()
	var sb strings.Builder
	fmt.Fprintf(&sb, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges"><path fill="#14183A" d="`, len(bm), len(bm))
	for y, row := range bm {
		for x, on := range row {
			if on {
				fmt.Fprintf(&sb, "M%d %dh1v1h-1z", x, y)
			}
		}
	}
	sb.WriteString(`"/></svg>`)
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.Write([]byte(sb.String()))
}

// lanAddrs lists this machine's private IPv4 addresses, so a page opened on
// localhost can still put a reachable address in its QR code.
func lanAddrs() []string {
	out := []string{}
	if inContainer {
		return out
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok {
			if ip := ipn.IP.To4(); ip != nil && ip.IsPrivate() {
				out = append(out, ip.String())
			}
		}
	}
	return out
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; "+
			"style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; "+
			"img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; "+
			"object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// envFlags fills flags not given on the command line from QRCPY_* variables,
// e.g. QRCPY_PUBLIC_URL for -public-url.
func envFlags() {
	set := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { set[f.Name] = true })
	flag.VisitAll(func(f *flag.Flag) {
		env := "QRCPY_" + strings.ToUpper(strings.ReplaceAll(f.Name, "-", "_"))
		if v, ok := os.LookupEnv(env); ok && v != "" && !set[f.Name] {
			if err := f.Value.Set(v); err != nil {
				log.Fatalf("%s: %v", env, err)
			}
		}
	})
}

// checkHealth asks the server on -addr for /healthz, for container health checks.
func checkHealth() {
	host, port, err := net.SplitHostPort(*addr)
	if err != nil {
		log.Fatal(err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + net.JoinHostPort(host, port) + "/healthz")
	if err != nil {
		log.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Fatalf("unhealthy: %s", resp.Status)
	}
	os.Exit(0)
}

func main() {
	flag.Parse()
	envFlags()
	if *healthcheck {
		checkHealth()
	}

	h := &hub{
		rooms:   map[string]*room{},
		codes:   map[string]*room{},
		clients: map[string]*client{},
		fails:   map[string]*failWindow{},
		ice:     []iceServer{},
	}
	if *stunURL != "" {
		h.ice = append(h.ice, iceServer{URLs: []string{*stunURL}})
	}
	if *turnURL != "" {
		h.ice = append(h.ice, iceServer{URLs: []string{*turnURL}, Username: *turnUser, Credential: *turnPass})
	}
	go h.pruneFailures()

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	assets, err := loadAssets(static)
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/", serveAssets(assets))
	mux.HandleFunc("/ws", h.serveWS)
	mux.HandleFunc("/qr.svg", serveQR)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })

	srv := &http.Server{Addr: *addr, Handler: securityHeaders(mux), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()

	log.Printf("qrcpy listening on %s", *addr)
	switch {
	case *publicURL != "":
		log.Printf("  open %s on your devices", *publicURL)
	case inContainer:
		log.Printf("  set QRCPY_PUBLIC_URL to this machine's address so QR codes work from localhost")
	default:
		_, port, _ := net.SplitHostPort(*addr)
		for _, ip := range lanAddrs() {
			log.Printf("  open http://%s:%s on your devices", ip, port)
		}
	}
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
