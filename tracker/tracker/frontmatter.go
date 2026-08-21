package tracker

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// FrontMatter is the YAML front matter of a ticket file.
// Key order is fixed (G-Q9): id, title, map, type, status, triage, blocked_by,
// created_at, claimed_at, resolved_at.
type FrontMatter struct {
	ID         string     `yaml:"id"`
	Title      string     `yaml:"title"`
	Map        string     `yaml:"map"`
	Type       string     `yaml:"type"`
	Status     string     `yaml:"status"`
	Triage     *string    `yaml:"triage"`
	BlockedBy  []string   `yaml:"blocked_by"`
	CreatedAt  time.Time  `yaml:"created_at"`
	ReviewedAt *time.Time `yaml:"reviewed_at"`
	ClaimedAt  *time.Time `yaml:"claimed_at"`
	ResolvedAt *time.Time `yaml:"resolved_at"`
}

const timeFormat = "2006-01-02T15:04:05Z07:00"

// Marshal serializes FrontMatter to YAML with fixed key order, ending with "---".
func (fm FrontMatter) Marshal() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString("---\n")

	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)

	// Use yaml.Node to guarantee key order (G-Q9)
	node := fm.toNode()
	if err := enc.Encode(node); err != nil {
		return nil, fmt.Errorf("marshaling front matter: %w", err)
	}
	enc.Close()

	// yaml.Encoder adds a trailing newline; we need "---\n" after
	result := buf.String()
	// Remove the encoder's trailing newline, add our own separator
	result = strings.TrimRight(result, "\n") + "\n---\n"
	return []byte(result), nil
}

func (fm FrontMatter) toNode() *yaml.Node {
	n := &yaml.Node{Kind: yaml.MappingNode}
	add := func(key string, value *yaml.Node) {
		n.Content = append(n.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: key}, value)
	}

	add("id", quotedScalarNode(fm.ID))
	add("title", scalarNode(fm.Title))
	add("map", scalarNode(fm.Map))
	add("type", scalarNode(fm.Type))
	add("status", scalarNode(fm.Status))

	if fm.Triage == nil {
		add("triage", nullNode())
	} else {
		add("triage", scalarNode(*fm.Triage))
	}

	if len(fm.BlockedBy) == 0 {
		add("blocked_by", &yaml.Node{Kind: yaml.SequenceNode, Style: yaml.FlowStyle})
	} else {
		seq := &yaml.Node{Kind: yaml.SequenceNode, Style: yaml.FlowStyle}
		for _, id := range fm.BlockedBy {
			seq.Content = append(seq.Content, quotedScalarNode(id))
		}
		add("blocked_by", seq)
	}

	add("created_at", scalarNode(fm.CreatedAt.Format(timeFormat)))

	if fm.ReviewedAt == nil {
		add("reviewed_at", nullNode())
	} else {
		add("reviewed_at", scalarNode(fm.ReviewedAt.Format(timeFormat)))
	}

	if fm.ClaimedAt == nil {
		add("claimed_at", nullNode())
	} else {
		add("claimed_at", scalarNode(fm.ClaimedAt.Format(timeFormat)))
	}

	if fm.ResolvedAt == nil {
		add("resolved_at", nullNode())
	} else {
		add("resolved_at", scalarNode(fm.ResolvedAt.Format(timeFormat)))
	}

	return n
}

func scalarNode(s string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Value: s}
}

// quotedScalarNode forces double-quote style (for id-like strings that look like numbers).
func quotedScalarNode(s string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Value: s, Style: yaml.DoubleQuotedStyle}
}

func nullNode() *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}
}

// ParseFrontMatter parses YAML front matter (starting with "---") into FrontMatter.
func ParseFrontMatter(data []byte) (FrontMatter, error) {
	content := string(data)

	// Strip leading "---"
	if strings.HasPrefix(content, "---\n") {
		content = strings.TrimPrefix(content, "---\n")
	} else if strings.HasPrefix(content, "---") {
		content = strings.TrimPrefix(content, "---")
	}

	// Find closing "---"
	endIdx := strings.Index(content, "\n---")
	if endIdx >= 0 {
		content = content[:endIdx]
	} else if idx := strings.Index(content, "---"); idx >= 0 {
		content = content[:idx]
	}

	var fm FrontMatter
	dec := yaml.NewDecoder(strings.NewReader(content))
	dec.KnownFields(true)
	if err := dec.Decode(&fm); err != nil {
		return FrontMatter{}, fmt.Errorf("parsing front matter: %w", err)
	}

	// Ensure blocked_by is never nil (always [] for consistency)
	if fm.BlockedBy == nil {
		fm.BlockedBy = []string{}
	}

	return fm, nil
}
