package gateway

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
)

type BlobStore interface {
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) (string, error)
}

type FilerStore struct {
	Endpoint string
	Public   string
	Client   *http.Client
}

func (f *FilerStore) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) (string, error) {
	endpoint := strings.TrimRight(f.Endpoint, "/")
	public := strings.TrimRight(f.Public, "/")
	if public == "" {
		public = endpoint
	}
	key = strings.TrimLeft(key, "/")
	if endpoint == "" || key == "" {
		return "", fmt.Errorf("filer url")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint+"/"+key, r)
	if err != nil {
		return "", err
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	req.Header.Set("Content-Type", contentType)
	if size >= 0 {
		req.ContentLength = size
	}
	client := f.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return "", fmt.Errorf("filer %d", res.StatusCode)
	}
	return public + "/" + key, nil
}

func ClassifyFileType(contentType, filename string) string {
	ct := strings.ToLower(contentType)
	switch {
	case strings.HasPrefix(ct, "image/"):
		return "image"
	case strings.HasPrefix(ct, "audio/"):
		return "audio"
	case strings.HasPrefix(ct, "video/"):
		return "video"
	}
	switch strings.ToLower(path.Ext(filename)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg":
		return "image"
	case ".mp3", ".wav", ".ogg", ".m4a":
		return "audio"
	case ".mp4", ".webm", ".mov":
		return "video"
	}
	return "file"
}

func sanitizeFilename(name string) string {
	base := path.Base(strings.ReplaceAll(name, "\\", "/"))
	if base == "" || base == "." || base == ".." {
		return "file"
	}
	return base
}
