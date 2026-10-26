package tracker

import (
	"regexp"
	"strconv"
	"strings"
)

// Closing-pattern parsing (shared by close-verify across backends).
//
// GitHub and GitLab recognize the same keyword set: close(s|d), fix(e|es|ed),
// resolve(s|d|e) — case-insensitive, optionally followed by ':' — applied to
// one issue reference or a comma/and-separated list ("Closes #1, fixes #2",
// "Resolves #1 and #2").
//
// Known gap this exists to close: merge commits into non-default branches,
// merge commits carrying multiple refs (only the first is auto-processed by
// the platform), and squash merges dropping refs from individual commit
// bodies. close-verify re-scans ALL texts (PR/MR description + every commit
// message) instead of trusting the platform's automatic processing.

// closingKeywordRe matches a closing keyword. Negated mentions ("does not
// close #5", "won't fix #7") are not closing claims and must not close
// tickets via --apply (ocr finding H3); they are filtered by
// isNegatedClosing after the match, using the tokens before the keyword —
// RE2 has no lookbehind, so negation cannot be expressed in one pattern.
var closingKeywordRe = regexp.MustCompile(`(?im)(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*`)

// negationWords are checked in the window before a keyword match. "will not
// close" spans three tokens, so the window is token-based, not fixed-width.
var negationWords = []string{"not", "no", "never", "won't", "don't", "doesn't", "didn't", "can't", "cannot", "won", "don", "doesn", "didn", "cant"}

var closingListRe = regexp.MustCompile(`#\d+(?:\s*[,;&]?\s*(?:and\s+)?#\d+)*`)
var refNumRe = regexp.MustCompile(`#(\d+)`)

// isNegatedClosing reports whether the closing-keyword match starting at
// start is preceded by a negation word (skipping fillers like "to", "be",
// "this", "it", "going").
func isNegatedClosing(text string, start int) bool {
	before := text[max(0, start-40):start] // 40 chars covers "will definitely not "
	before = strings.TrimRight(before, " \t:,;(")
	tokens := strings.Fields(strings.ToLower(before))
	// "but"/"and"/"also" separate clauses: negation before them does not
	// apply to this keyword ("not related, but closes #6" closes #6).
	for i := len(tokens) - 1; i >= 0 && i >= len(tokens)-3; i-- {
		if tokens[i] == "but" || tokens[i] == "and" || tokens[i] == "also" {
			return false
		}
		for _, neg := range negationWords {
			if tokens[i] == neg {
				return true
			}
		}
	}
	return false
}

// ParseClosingRefs extracts issue numbers referenced by closing patterns in
// text, deduplicated, first-occurrence order preserved. Numbers keep the
// "#"-free decimal form ("Closes #1" → "1"). References too large for an
// issue number (>10 digits) are skipped rather than silently corrupted.
func ParseClosingRefs(text string) []string {
	var refs []string
	seen := map[string]bool{}
	for _, loc := range closingKeywordRe.FindAllStringIndex(text, -1) {
		if isNegatedClosing(text, loc[0]) {
			continue
		}
		rest := text[loc[1]:]
		m := closingListRe.FindStringIndex(rest)
		if m == nil || m[0] != 0 {
			continue // keyword not immediately followed by refs
		}
		for _, ref := range refNumRe.FindAllStringSubmatch(rest[:m[1]], -1) {
			if len(ref[1]) > 10 {
				continue // overflow guard: not a plausible issue number
			}
			n := strconv.Itoa(mustAtoi(ref[1])) // normalize "#007" → "7"
			if !seen[n] {
				seen[n] = true
				refs = append(refs, n)
			}
		}
	}
	return refs
}

func mustAtoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
