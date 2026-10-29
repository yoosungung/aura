package core

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

const (
	argonTime    uint32 = 2
	argonMemory  uint32 = 19456
	argonThreads uint8  = 1
	argonKeyLen  uint32 = 32
	argonSaltLen        = 16
)

var dummyDigest = sync.OnceValue(func() string {
	d, err := HashPassword("timing-pad")
	if err != nil {
		return ""
	}
	return d
})

func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

func CheckPassword(digest, password string) bool {
	salt, key, time, memory, threads, ok := parseArgon(digest)
	if !ok {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, time, memory, threads, uint32(len(key)))
	return subtle.ConstantTimeCompare(got, key) == 1
}

func parseArgon(digest string) (salt, key []byte, time, memory uint32, threads uint8, ok bool) {
	parts := strings.Split(digest, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return nil, nil, 0, 0, 0, false
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return nil, nil, 0, 0, 0, false
	}
	param := map[string]string{}
	for _, p := range strings.Split(parts[3], ",") {
		k, v, found := strings.Cut(p, "=")
		if !found {
			return nil, nil, 0, 0, 0, false
		}
		param[k] = v
	}
	m, err1 := strconv.ParseUint(param["m"], 10, 32)
	t, err2 := strconv.ParseUint(param["t"], 10, 32)
	p, err3 := strconv.ParseUint(param["p"], 10, 8)
	if err1 != nil || err2 != nil || err3 != nil {
		return nil, nil, 0, 0, 0, false
	}
	enc := base64.RawStdEncoding
	salt, err := enc.DecodeString(parts[4])
	if err != nil {
		return nil, nil, 0, 0, 0, false
	}
	key, err = enc.DecodeString(parts[5])
	if err != nil || len(key) == 0 {
		return nil, nil, 0, 0, 0, false
	}
	return salt, key, uint32(t), uint32(m), uint8(p), true
}
