package tracker

import "errors"

var (
	ErrNotFound        = errors.New("not found")
	ErrAlreadyResolved = errors.New("already resolved")
	ErrAlreadyClaimed  = errors.New("already claimed")
	ErrCycleDetected   = errors.New("cycle detected")
	ErrHeadingMissing  = errors.New("heading missing")
	ErrInvalidInput    = errors.New("invalid input")
)
