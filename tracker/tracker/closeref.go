package tracker

import (
	"regexp"
	"strconv"
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

var closingKeywordRe = regexp.MustCompile(`(?im)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*`)
var closingListRe = regexp.MustCompile(`#\d+(?:\s*[,;&]?\s*(?:and\s+)?#\d+)*`)

// ParseClosingRefs extracts issue numbers referenced by closing patterns in
// text, deduplicated, first-occurrence order preserved. Numbers keep the
// "#"-free decimal form ("Closes #1" → "1").
func ParseClosingRefs(text string) []string {
	var refs []string
	seen := map[string]bool{}
	for _, loc := range closingKeywordRe.FindAllStringIndex(text, -1) {
		rest := text[loc[1]:]
		m := closingListRe.FindStringIndex(rest)
		if m == nil || m[0] != 0 {
			continue // keyword not immediately followed by refs
		}
		for _, ref := range regexp.MustCompile(`#(\d+)`).FindAllStringSubmatch(rest[:m[1]], -1) {
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
