package tracker

import "testing"

func TestSlug(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"simple", "Test ticket", "test-ticket"},
		{"colon and spaces", "Spec: PPU MIG 调度实现", "spec-ppu-mig-调度实现"},
		{"punctuation deleted", "Fix bug #123 (urgent!)", "fix-bug-123-urgent"},
		{"all ascii punct deleted", "A!B@C#D$E", "abcde"},
		{"consecutive hyphens", "A  B   C", "a-b-c"},
		{"leading trailing hyphens", "  hello  ", "hello"},
		{"hyphen preserved", "already-hyphenated", "already-hyphenated"},
		{"underscore deleted", "foo_bar baz", "foobar-baz"},
		{"empty after cleanup", "!!!", ""},
		{"truncate 50 runes", string(make([]rune, 60)) /* all NUL → deleted */, ""},
		{"truncate mixed", "a" + string(make([]rune, 55)) + "b" /* NULs deleted, a+b = 2 chars */, "ab"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Slug(tt.input)
			if got != tt.want {
				t.Errorf("Slug(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestSlugTruncateRunes(t *testing.T) {
	// 60 Chinese chars — each is 1 rune, 3 bytes. Max 50 runes.
	input := ""
	for i := 0; i < 60; i++ {
		input += "调"
	}
	got := Slug(input)
	if runeCount := len([]rune(got)); runeCount > 50 {
		t.Errorf("Slug() produced %d runes, want <= 50", runeCount)
	}
	if runeCount := len([]rune(got)); runeCount != 50 {
		t.Errorf("Slug() produced %d runes, want exactly 50", runeCount)
	}
}
