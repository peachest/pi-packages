package tracker

import (
	"slices"
	"testing"
)

func TestParseClosingRefs(t *testing.T) {
	tests := []struct {
		name string
		text string
		want []string
	}{
		{"simple", "Closes #1", []string{"1"}},
		{"lowercase", "fixes #12", []string{"12"}},
		{"with colon", "Fixes: #3", []string{"3"}},
		{"multiple keywords", "Closes #1, fixes #2", []string{"1", "2"}},
		{"comma list", "Closes #1, #2", []string{"1", "2"}},
		{"and list", "Resolves #1 and #2", []string{"1", "2"}},
		{"abbreviated verb", "Fix #4", []string{"4"}},
		{"past tense", "closed #5", []string{"5"}},
		{"multi-line", "first fixes #1\nthen resolves #2", []string{"1", "2"}},
		{"dedup across sections", "Closes #1\n\ncommit: fixes #1, closes #2", []string{"1", "2"}},
		{"no keyword", "see issue #1, refs #2", nil},
		{"keyword without ref", "this closes the discussion", nil},
		{"no false positive on closing", "closing #1 is not a keyword", nil},
		{"ref not adjacent", "fixes later #1", nil},
		{"zero padded", "Closes #007", []string{"7"}},
		{"negated: does not close", "This does not close #5", nil},
		{"negated: won't fix", "won't fix #7", nil},
		{"negated: doesn't resolve", "doesn't resolve #3", nil},
		{"negated: will not close", "we will not close #8", nil},
		{"negated mid-text", "We decided not to close #9 today", nil},
		{"negation elsewhere is fine", "not related, but closes #6", []string{"6"}},
		{"overflow ref skipped", "Closes #99999999999999999999999", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseClosingRefs(tt.text)
			if !slices.Equal(got, tt.want) {
				t.Errorf("ParseClosingRefs(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}
