package tracker

import (
	"bytes"
	"strings"
	"time"

	"github.com/pkg/errors"
	"gopkg.in/yaml.v3"
)

// MilestoneFrontMatter is the YAML front matter of a milestone file.
// Separate from MapFrontMatter — milestone has no milestone field (it IS a milestone).
// File: .scratch/.milestones/<slug>.md, created by agent manually (grilling Q3=A).
type MilestoneFrontMatter struct {
	Title     string     `yaml:"title"`
	State     string     `yaml:"state"`
	CreatedAt time.Time  `yaml:"created_at"`
	ClosedAt  *time.Time `yaml:"closed_at"`
}

// Marshal serializes MilestoneFrontMatter to YAML with fixed key order.
func (mfm MilestoneFrontMatter) Marshal() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString("---\n")

	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)

	node := &yaml.Node{Kind: yaml.MappingNode}
	add := func(key string, value *yaml.Node) {
		node.Content = append(node.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: key}, value)
	}

	add("title", scalarNode(mfm.Title))
	add("state", scalarNode(mfm.State))
	add("created_at", scalarNode(mfm.CreatedAt.Format(timeFormat)))

	if mfm.ClosedAt == nil {
		add("closed_at", nullNode())
	} else {
		add("closed_at", scalarNode(mfm.ClosedAt.Format(timeFormat)))
	}

	if err := enc.Encode(node); err != nil {
		return nil, errors.Wrapf(err, "marshaling milestone front matter")
	}
	enc.Close()

	result := strings.TrimRight(buf.String(), "\n") + "\n---\n"
	return []byte(result), nil
}

// ParseMilestoneFrontMatter parses YAML front matter from a milestone file.
func ParseMilestoneFrontMatter(data []byte) (MilestoneFrontMatter, error) {
	content := string(data)

	if strings.HasPrefix(content, "---\n") {
		content = strings.TrimPrefix(content, "---\n")
	}

	endIdx := strings.Index(content, "\n---")
	if endIdx >= 0 {
		content = content[:endIdx]
	} else if idx := strings.Index(content, "---"); idx >= 0 {
		content = content[:idx]
	}

	var mfm MilestoneFrontMatter
	dec := yaml.NewDecoder(strings.NewReader(content))
	dec.KnownFields(true)
	if err := dec.Decode(&mfm); err != nil {
		return MilestoneFrontMatter{}, errors.Wrapf(err, "parsing milestone front matter")
	}

	return mfm, nil
}
