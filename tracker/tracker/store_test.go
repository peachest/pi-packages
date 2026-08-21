package tracker

import (
	"testing"

	"github.com/spf13/afero"
)

func TestFindScratchDir(t *testing.T) {
	tests := []struct {
		name    string
		setup   func(fs afero.Fs) string // returns cwd
		wantDir string
		wantErr bool
	}{
		{
			name: "found in cwd",
			setup: func(fs afero.Fs) string {
				fs.MkdirAll("/project/.scratch", 0755)
				return "/project"
			},
			wantDir: "/project/.scratch",
		},
		{
			name: "found in parent",
			setup: func(fs afero.Fs) string {
				fs.MkdirAll("/project/.scratch", 0755)
				fs.MkdirAll("/project/subdir", 0755)
				return "/project/subdir"
			},
			wantDir: "/project/.scratch",
		},
		{
			name: "not found, no git",
			setup: func(fs afero.Fs) string {
				fs.MkdirAll("/newproject", 0755)
				return "/newproject"
			},
			wantDir: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fs := afero.NewMemMapFs()
			cwd := tt.setup(fs)

			got, err := FindScratchDir(fs, cwd)
			if (err != nil) != tt.wantErr {
				t.Fatalf("FindScratchDir() error = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.wantDir {
				t.Errorf("FindScratchDir() = %q, want %q", got, tt.wantDir)
			}
		})
	}
}

func TestEnsureScratchDir(t *testing.T) {
	t.Run("creates when not found", func(t *testing.T) {
		fs := afero.NewMemMapFs()
		fs.MkdirAll("/project", 0755)

		got, err := EnsureScratchDir(fs, "/project")
		if err != nil {
			t.Fatalf("EnsureScratchDir() error = %v", err)
		}
		if got != "/project/.scratch" {
			t.Errorf("EnsureScratchDir() = %q, want /project/.scratch", got)
		}

		exists, _ := afero.DirExists(fs, "/project/.scratch")
		if !exists {
			t.Error(".scratch/ was not created")
		}
	})

	t.Run("uses existing", func(t *testing.T) {
		fs := afero.NewMemMapFs()
		fs.MkdirAll("/project/.scratch/some-map", 0755)

		got, err := EnsureScratchDir(fs, "/project")
		if err != nil {
			t.Fatalf("EnsureScratchDir() error = %v", err)
		}
		if got != "/project/.scratch" {
			t.Errorf("EnsureScratchDir() = %q, want /project/.scratch", got)
		}
	})
}

func TestMapExists(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/p/.scratch/my-map/issues", 0755)
	afero.WriteFile(fs, "/p/.scratch/my-map/map.md", []byte("# My Map"), 0644)

	scratchDir := "/p/.scratch"

	if !MapExists(fs, scratchDir, "my-map") {
		t.Error("MapExists() = false, want true for existing map")
	}
	if MapExists(fs, scratchDir, "nonexistent") {
		t.Error("MapExists() = true for nonexistent map")
	}
}
