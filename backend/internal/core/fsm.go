package core

import "errors"

const (
	StatusUnassigned = "unassigned"
	StatusOpen       = "open"
	StatusPending    = "pending"
	StatusResolved   = "resolved"
)

var (
	ErrConflict     = errors.New("conflict")
	ErrForbidden    = errors.New("forbidden_transition")
	ErrNotFound     = errors.New("not_found")
	ErrUnauthorized = errors.New("unauthorized")
	ErrDenied       = errors.New("forbidden")
	ErrInvalid      = errors.New("invalid")
)

var allowed = map[string][]string{
	StatusUnassigned: {StatusOpen, StatusResolved},
	StatusOpen:       {StatusPending, StatusResolved, StatusUnassigned},
	StatusPending:    {StatusOpen, StatusResolved},
	StatusResolved:   {StatusOpen},
}

func CanTransition(from, to string) bool {
	for _, s := range allowed[from] {
		if s == to {
			return true
		}
	}
	return false
}
