package tracker

import (
	"bytes"
	"os"
	"strings"
	"time"

	"github.com/pkg/errors"
	"gopkg.in/yaml.v3"
)

// MapFrontMatter is the YAML front matter of a map.md file.
type MapFrontMatter struct {
	Title     string     `yaml:"title"`
	State     string     `yaml:"state"`
	Milestone *string    `yaml:"milestone"`
	CreatedAt time.Time  `yaml:"created_at"`
	ClosedAt  *time.Time `yaml:"closed_at"`
}

// Progress holds ticket status counts for a map or milestone.
// Does NOT include frontier_size (G-Q6).
type Progress struct {
	Open     int `json:"open"`
	Claimed  int `json:"claimed"`
	Resolved int `json:"resolved"`
	Total    int `json:"total"`
}

// Marshal serializes MapFrontMatter to YAML with fixed key order.
func (mfm MapFrontMatter) Marshal() ([]byte, error) {
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

	if mfm.Milestone == nil {
		add("milestone", nullNode())
	} else {
		add("milestone", scalarNode(*mfm.Milestone))
	}

	add("created_at", scalarNode(mfm.CreatedAt.Format(timeFormat)))

	if mfm.ClosedAt == nil {
		add("closed_at", nullNode())
	} else {
		add("closed_at", scalarNode(mfm.ClosedAt.Format(timeFormat)))
	}

	if err := enc.Encode(node); err != nil {
		return nil, errors.Wrapf(err, "marshaling map front matter")
	}
	enc.Close()

	result := strings.TrimRight(buf.String(), "\n") + "\n---\n"
	return []byte(result), nil
}

// ParseMapFrontMatter parses YAML front matter from a map.md file.
func ParseMapFrontMatter(data []byte) (MapFrontMatter, error) {
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

	var mfm MapFrontMatter
	dec := yaml.NewDecoder(strings.NewReader(content))
	dec.KnownFields(true)
	if err := dec.Decode(&mfm); err != nil {
		return MapFrontMatter{}, errors.Wrapf(err, "parsing map front matter")
	}

	return mfm, nil
}

// ComputeProgress scans all tickets in a map and returns status counts (G-Q6).
// Does NOT include frontier_size — use ComputeFrontierSize() for that.
func ComputeProgress(root *os.Root, mapSlug string) (Progress, error) {
	tickets, err := ListTickets(root, mapSlug, ListFilter{})
	if err != nil {
		return Progress{}, errors.Wrapf(err, "listing tickets for progress")
	}

	p := Progress{Total: len(tickets)}
	for _, t := range tickets {
		switch t.Status {
		case "open":
			p.Open++
		case "claimed":
			p.Claimed++
		case "resolved":
			p.Resolved++
		}
	}

	return p, nil
}
