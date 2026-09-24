//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

// LockFileEx flags: fail fast instead of waiting, exclusive instead of shared.
const (
	lockfileExclusiveLock   = 0x00000002
	lockfileFailImmediately = 0x00000001
)

var procLockFileEx = syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx")

// lockExclusive takes a non-blocking exclusive byte-range lock over the whole
// file — the Windows equivalent of flock(LOCK_EX|LOCK_NB) for the id-file
// claim: ERROR_LOCK_VIOLATION maps to a held lock (sibling owns it), and the
// OS releases the lock when the owning process exits. An empty lock over the
// whole 64-bit range so files of any size are covered.
func lockExclusive(f *os.File) error {
	const (
		startLo = 0
		startHi = 0
		lenLo   = ^uint32(0) // whole file: max 32-bit halves of the 64-bit range
		lenHi   = ^uint32(0)
	)
	ol := &syscall.Overlapped{}
	r1, _, errNo := procLockFileEx.Call(
		uintptr(f.Fd()),
		uintptr(lockfileFailImmediately|lockfileExclusiveLock),
		uintptr(startLo),
		uintptr(lenLo),
		uintptr(lenHi),
		uintptr(unsafe.Pointer(ol)),
	)
	if r1 == 0 {
		return errNo
	}
	return nil
}
