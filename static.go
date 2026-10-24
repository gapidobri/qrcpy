package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// asset is an embedded web file, held in memory with a gzipped copy.
type asset struct {
	body, gz    []byte
	ctype       string
	etag, gzTag string
}

// loadAssets reads every file in fsys once and compresses it, so requests
// are served straight from memory.
func loadAssets(fsys fs.FS) (map[string]*asset, error) {
	assets := map[string]*asset{}
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		body, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(body)
		tag := hex.EncodeToString(sum[:8])
		a := &asset{body: body, ctype: mime.TypeByExtension(path.Ext(p)), etag: `"` + tag + `"`, gzTag: `"` + tag + `-gz"`}
		if a.ctype == "" {
			a.ctype = "application/octet-stream"
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		zw.Write(body)
		zw.Close()
		if buf.Len() < len(body) {
			a.gz = buf.Bytes()
		}
		assets["/"+p] = a
		return nil
	})
	assets["/"] = assets["/index.html"]
	return assets, err
}

// serveAssets serves the loaded files. Browsers revalidate with the ETag on
// each load, so a new build shows up right away without stale caches.
func serveAssets(assets map[string]*asset) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a, ok := assets[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		body, tag := a.body, a.etag
		h := w.Header()
		if a.gz != nil {
			h.Set("Vary", "Accept-Encoding")
			if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
				body, tag = a.gz, a.gzTag
				h.Set("Content-Encoding", "gzip")
			}
		}
		h.Set("Content-Type", a.ctype)
		h.Set("ETag", tag)
		h.Set("Cache-Control", "no-cache")
		if r.Header.Get("If-None-Match") == tag {
			h.Del("Content-Encoding")
			w.WriteHeader(http.StatusNotModified)
			return
		}
		h.Set("Content-Length", strconv.Itoa(len(body)))
		if r.Method != http.MethodHead {
			w.Write(body)
		}
	}
}
