package main

import (
	"log"
	"path/filepath"
	"runtime"

	"github.com/yoosungung/aura/internal/contractgen"
)

func main() {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		log.Fatal("no caller")
	}
	backend := filepath.Clean(filepath.Join(filepath.Dir(file), "../.."))
	if err := contractgen.Generate(
		filepath.Join(backend, "../contracts"),
		filepath.Join(backend, "internal/contracts/gen.go"),
	); err != nil {
		log.Fatal(err)
	}
}
