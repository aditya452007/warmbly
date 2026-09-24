//go:build !windows

package main

import (
	"os"
	"syscall"
)

// lockExclusive takes a non-blocking exclusive advisory lock held until the
// process exits: flock(LOCK_EX|LOCK_NB), the primitive the id-file claim
// relies on, so a sibling replica that still owns the file leaves it claimed
// and the OS releases the lock the moment the owner dies.
func lockExclusive(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}
