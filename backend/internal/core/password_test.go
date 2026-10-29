package core_test

import (
	"testing"

	"github.com/yoosungung/aura/internal/core"
)

func TestPassword_HashThenCheck(t *testing.T) {
	digest, err := core.HashPassword("s3cret")
	if err != nil {
		t.Fatal(err)
	}
	if !core.CheckPassword(digest, "s3cret") {
		t.Fatal("expected match")
	}
	if core.CheckPassword(digest, "wrong") {
		t.Fatal("wrong password matched")
	}
	if core.CheckPassword("", "s3cret") || core.CheckPassword("not-argon", "s3cret") {
		t.Fatal("garbage digest matched")
	}
}
