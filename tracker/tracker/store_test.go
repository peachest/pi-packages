package tracker

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFindScratchDir(t *testing.T) {
	tests := []struct {
		name    string
		setup   func(t *testing.T) string // returns cwd
		wantDir string
		wantErr bool
	}{
		{
			name: "found in cwd",
			setup: func(t *testing.T) string {
				base := t.TempDir()
				os.MkdirAll(filepath.Join(base, ".scratch"), 0755)
				return base
			},
			// wantDir set in test body (depends on tempdir)
		},
		{
			name: "found in parent",
			setup: func(t *testing.T) string {
				base := t.TempDir()
				os.MkdirAll(filepath.Join(base, ".scratch"), 0755)
				sub := filepath.Join(base, "subdir")
				os.MkdirAll(sub, 0755)
				return sub
			},
		},
		{
			name: "not found",
			setup: func(t *testing.T) string {
				return t.TempDir()
			},
			wantDir: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cwd := tt.setup(t)
			got, err := FindScratchDir(cwd)
			if (err != nil) != tt.wantErr {
				t.Fatalf("FindScratchDir() error = %v, wantErr %v", err, tt.wantErr)
			}
			// For "found" cases, the result should end with .scratch
			if tt.name != "not found" {
				want := filepath.Join(filepath.Dir(cwd), ".scratch")
				if tt.name == "found in cwd" {
					want = filepath.Join(cwd, ".scratch")
				}
				if got != want {
					t.Errorf("FindScratchDir() = %q, want %q", got, want)
				}
			} else if got != tt.wantDir {
				t.Errorf("FindScratchDir() = %q, want %q", got, tt.wantDir)
			}
		})
	}
}

func TestEnsureScratchDir(t *testing.T) {
	t.Run("creates at cwd when not in git repo", func(t *testing.T) {
		base := t.TempDir()
		oldGit := gitRootFunc
		gitRootFunc = func(dir string) (string, error) { return "", nil }
		defer func() { gitRootFunc = oldGit }()

		got, err := EnsureScratchDir(base)
		if err != nil {
			t.Fatalf("EnsureScratchDir() error = %v", err)
		}
		want := filepath.Join(base, ".scratch")
		if got != want {
			t.Errorf("EnsureScratchDir() = %q, want %q", got, want)
		}
		if fi, err := os.Stat(want); err != nil || !fi.IsDir() {
			t.Errorf("expected .scratch dir created at %s", want)
		}
	})

	t.Run("creates at git root when in git repo (S1)", func(t *testing.T) {
		repo := t.TempDir()
		subdir := filepath.Join(repo, "subdir")
		os.MkdirAll(subdir, 0755)
		oldGit := gitRootFunc
		gitRootFunc = func(dir string) (string, error) { return repo, nil }
		defer func() { gitRootFunc = oldGit }()

		got, err := EnsureScratchDir(subdir)
		if err != nil {
			t.Fatalf("EnsureScratchDir() error = %v", err)
		}
		want := filepath.Join(repo, ".scratch")
		if got != want {
			t.Errorf("EnsureScratchDir() = %q, want %q (git root)", got, want)
		}
	})

	t.Run("uses existing", func(t *testing.T) {
		base := t.TempDir()
		os.MkdirAll(filepath.Join(base, ".scratch", "some-map"), 0755)
		oldGit := gitRootFunc
		gitRootFunc = func(dir string) (string, error) { return "", nil }
		defer func() { gitRootFunc = oldGit }()

		got, err := EnsureScratchDir(base)
		if err != nil {
			t.Fatalf("EnsureScratchDir() error = %v", err)
		}
		want := filepath.Join(base, ".scratch")
		if got != want {
			t.Errorf("EnsureScratchDir() = %q, want %q", got, want)
		}
	})
}

func TestMapExists(t *testing.T) {
	root := newTestRoot(t)
	root.MkdirAll("my-map/issues", 0755)
	root.WriteFile("my-map/map.md", []byte("# My Map"), 0644)

	exists, err := MapExists(root, "my-map")
	if err != nil {
		t.Fatalf("MapExists() error = %v", err)
	}
	if !exists {
		t.Error("MapExists() = false, want true for existing map")
	}
	exists, err = MapExists(root, "nonexistent")
	if err != nil {
		t.Fatalf("MapExists() error = %v", err)
	}
	if exists {
		t.Error("MapExists() = true for nonexistent map")
	}
}

func TestMapExistsRejectsTraversal(t *testing.T) {
	root := newTestRoot(t)
	// os.Root rejects path traversal at the kernel level (openat).
	// MapExists returns an error for "../etc" instead of a sentinel;
	// the path cannot escape the sandbox.
	exists, err := MapExists(root, "../etc")
	if err == nil {
		t.Fatal("MapExists() with ../etc should return error, got nil (path escaped sandbox)")
	}
	if exists {
		t.Error("MapExists() = true for traversal slug")
	}
}
