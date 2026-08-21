package tracker

import (
	"strings"
	"unicode"
)

// Slug generates a ticket filename slug from a title.
// Rules (G-Q8):
//   - lowercase all ASCII characters
//   - spaces → hyphens
//   - delete all ASCII punctuation EXCEPT hyphen
//   - non-ASCII (中文 etc.) preserved
//   - collapse consecutive hyphens
//   - strip leading/trailing hyphens
//   - truncate to max 50 runes
func Slug(title string) string {
	var b strings.Builder
	for _, r := range title {
		switch {
		case r == ' ' || r == '-':
			b.WriteRune('-')
		case r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r)):
			b.WriteRune(unicode.ToLower(r))
		case r >= 128:
			// non-ASCII preserved (letters, digits, symbols, punctuation)
			b.WriteRune(r)
		default:
			// ASCII punctuation, symbols, controls — deleted
		}
	}

	s := b.String()
	// collapse consecutive hyphens
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	// strip leading/trailing hyphens
	s = strings.Trim(s, "-")

	// truncate to 50 runes
	runes := []rune(s)
	if len(runes) > 50 {
		runes = runes[:50]
		s = string(runes)
	}

	return s
}
