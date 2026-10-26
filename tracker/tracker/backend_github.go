package tracker

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/errors"
)

// GitHubBackend implements Backend by shelling out to `gh`.
// All gh calls use the REST/GraphQL JSON output (--json / gh api) and parse
// into the structs below; gh's human-readable output is only parsed for
// `issue create` (which prints the issue URL).
type GitHubBackend struct {
	run  Runner
	repo string
}

func NewGitHubBackend(run Runner, repo string) *GitHubBackend {
	return &GitHubBackend{run: run, repo: repo}
}

func (g *GitHubBackend) gh(args ...string) ([]byte, error) {
	out, err := g.run.Run(nil, "gh", args...)
	if err != nil {
		return nil, errors.Wrapf(err, "gh %s", strings.Join(args, " "))
	}
	return out, nil
}

func (g *GitHubBackend) ghJSON(v any, args ...string) error {
	out, err := g.gh(args...)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(out, v); err != nil {
		return errors.Wrapf(err, "parsing gh output: gh %s", strings.Join(args, " "))
	}
	return nil
}

// ensureLabel creates label if missing (idempotent). gh does NOT auto-create
// labels on issue create/edit, unlike GitLab.
func (g *GitHubBackend) ensureLabel(name string) error {
	_, err := g.gh("label", "create", name, "-R", g.repo)
	if err == nil {
		return nil
	}
	// gh errors with "already exists" when the label is present — that's fine.
	return nil
}

type ghLabel struct{ Name string }

type ghComment struct {
	Author struct {
		Login string `json:"login"`
	} `json:"author"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"createdAt"`
}

type ghIssue struct {
	Number    int         `json:"number"`
	Title     string      `json:"title"`
	State     string      `json:"state"` // OPEN | CLOSED
	Labels    []ghLabel   `json:"labels"`
	Body      string      `json:"body"`
	CreatedAt time.Time   `json:"createdAt"`
	URL       string      `json:"url"`
	Comments  []ghComment `json:"comments"`
}

// toSummary maps a gh issue onto the shared TicketSummary vocabulary.
// Status: CLOSED → resolved; OPEN + label status/claimed → claimed; else open.
func ghIssueToSummary(issue ghIssue, mapSlug string) TicketSummary {
	status := "open"
	if issue.State == "CLOSED" {
		status = "resolved"
	} else {
		for _, l := range issue.Labels {
			if l.Name == "status/claimed" {
				status = "claimed"
			}
		}
	}
	var triage *string
	var typ string
	for _, l := range issue.Labels {
		if v, ok := strings.CutPrefix(l.Name, "triage/"); ok {
			triage = &v
		}
		if v, ok := strings.CutPrefix(l.Name, "type/"); ok {
			typ = v
		}
	}
	return TicketSummary{
		ID:        strconv.Itoa(issue.Number),
		Title:     issue.Title,
		Map:       mapSlug,
		Type:      typ,
		Status:    status,
		Triage:    triage,
		BlockedBy: parseBlockedBy(issue.Body),
		Path:      issue.URL,
		CreatedAt: issue.CreatedAt,
	}
}

func (g *GitHubBackend) ListMaps() ([]MapSummary, error) {
	var labels []ghLabel
	if err := g.ghJSON(&labels, "label", "list", "-R", g.repo, "--json", "name", "--limit", "1000"); err != nil {
		return nil, err
	}
	var maps []MapSummary
	for _, l := range labels {
		if slug, ok := strings.CutPrefix(l.Name, "map/"); ok {
			// Map state/milestone/progress are local-markdown concepts; remote
			// maps report slug only, state pinned to "active", progress zeroed.
			maps = append(maps, MapSummary{Slug: slug, Title: slug, State: "active"})
		}
	}
	if maps == nil {
		maps = []MapSummary{}
	}
	return maps, nil
}

func (g *GitHubBackend) CreateTicket(opts TicketOpts) (TicketSummary, error) {
	if err := validateTicketOpts(opts); err != nil {
		return TicketSummary{}, err
	}
	if opts.BlockedBy == nil {
		opts.BlockedBy = []string{}
	}

	// Label set: map (identity), type, triage, status for claimed.
	labels := []string{mapLabel(opts.MapSlug), "type/" + opts.Type}
	if opts.Triage != nil {
		labels = append(labels, "triage/"+*opts.Triage)
	}
	for _, l := range labels {
		if err := g.ensureLabel(l); err != nil {
			return TicketSummary{}, err
		}
	}

	body := buildBodyWithBlockers("", opts.BlockedBy)
	out, err := g.gh("issue", "create", "-R", g.repo,
		"--title", opts.Title,
		"--body", body,
		"--label", strings.Join(labels, ","))
	if err != nil {
		return TicketSummary{}, err
	}
	// gh prints the issue URL on success.
	url := strings.TrimSpace(string(out))
	_, num, ok := strings.Cut(url, "/issues/")
	if !ok {
		return TicketSummary{}, errors.Wrapf(ErrInvalidInput, "cannot parse issue URL from gh output: %q", url)
	}
	return TicketSummary{
		ID:        remoteID(num),
		Title:     opts.Title,
		Map:       opts.MapSlug,
		Type:      opts.Type,
		Status:    "open",
		Triage:    opts.Triage,
		BlockedBy: opts.BlockedBy,
		Path:      url,
		CreatedAt: time.Now().UTC(),
	}, nil
}

func (g *GitHubBackend) ListTickets(mapSlug string, filter ListFilter) ([]TicketSummary, error) {
	args := []string{"issue", "list", "-R", g.repo, "--state", "all",
		"--label", mapLabel(mapSlug), "--limit", "1000",
		"--json", "number,title,state,labels,body,createdAt,url"}
	if filter.Type != "" {
		args = append(args, "--label", "type/"+filter.Type)
	}
	var issues []ghIssue
	if err := g.ghJSON(&issues, args...); err != nil {
		return nil, err
	}
	var tickets []TicketSummary
	for _, issue := range issues {
		t := ghIssueToSummary(issue, mapSlug)
		if !matchesFilter(t, filter) {
			continue
		}
		tickets = append(tickets, t)
	}
	if tickets == nil {
		tickets = []TicketSummary{}
	}
	return tickets, nil
}

func (g *GitHubBackend) GetTicket(mapSlug, ticketID string) (TicketDetail, error) {
	var issue ghIssue
	err := g.ghJSON(&issue, "issue", "view", remoteID(ticketID), "-R", g.repo,
		"--json", "number,title,state,labels,body,createdAt,url,comments")
	if err != nil {
		// gh exits non-zero with "Could not resolve to an issue" for missing IDs.
		if strings.Contains(err.Error(), "Could not resolve") || strings.Contains(err.Error(), "not found") {
			return TicketDetail{}, errors.Wrapf(ErrNotFound, "issue #%s not found in %s", remoteID(ticketID), g.repo)
		}
		return TicketDetail{}, err
	}
	detail := TicketDetail{TicketSummary: ghIssueToSummary(issue, mapSlug)}
	for _, c := range issue.Comments {
		detail.Comments = append(detail.Comments, TicketComment{
			Author:    c.Author.Login,
			CreatedAt: c.CreatedAt,
			Body:      c.Body,
		})
	}
	detail.Body = issue.Body
	return detail, nil
}

func (g *GitHubBackend) AddComment(mapSlug, ticketID, body string) error {
	_, err := g.gh("issue", "comment", remoteID(ticketID), "-R", g.repo, "--body", body)
	return err
}

func (g *GitHubBackend) SetStatus(mapSlug, ticketID, status string) error {
	if err := validateStatus(status); err != nil {
		return err
	}
	id := remoteID(ticketID)

	// Local-only preconditions (reviewed-at before claim, idempotent-claim
	// guard) have no GitHub equivalent; claimed is modeled as a label.
	if status == "claimed" {
		if err := g.ensureLabel("status/claimed"); err != nil {
			return err
		}
		_, err := g.gh("issue", "edit", id, "-R", g.repo, "--add-label", "status/claimed")
		return err
	}

	cur, err := g.GetTicket(mapSlug, id)
	if err != nil {
		return err
	}
	if status == "resolved" {
		if cur.Status == "resolved" {
			return nil // idempotent, mirrors local
		}
		// Clean up the claimed label so a resolved issue doesn't carry it.
		if cur.Status == "claimed" {
			if _, err := g.gh("issue", "edit", id, "-R", g.repo, "--remove-label", "status/claimed"); err != nil {
				return err
			}
		}
		_, err := g.gh("issue", "close", id, "-R", g.repo)
		return err
	}
	// status == "open": drop the claimed label, then reopen if closed.
	if cur.Status == "open" {
		return nil
	}
	if cur.Status == "claimed" {
		if _, err := g.gh("issue", "edit", id, "-R", g.repo, "--remove-label", "status/claimed"); err != nil {
			return err
		}
	}
	if cur.Status == "resolved" {
		_, err := g.gh("issue", "reopen", id, "-R", g.repo)
		return err
	}
	return nil
}

func (g *GitHubBackend) SetTriage(mapSlug, ticketID, triage string) error {
	if !inList(validTriages, triage) {
		return errors.Wrapf(ErrInvalidInput, "invalid triage %q, valid values: %v", triage, validTriages)
	}
	id := remoteID(ticketID)
	cur, err := g.GetTicket(mapSlug, id)
	if err != nil {
		return err
	}
	if err := g.ensureLabel("triage/" + triage); err != nil {
		return err
	}
	args := []string{"issue", "edit", id, "-R", g.repo, "--add-label", "triage/" + triage}
	if cur.Triage != nil && *cur.Triage != triage {
		args = append(args, "--remove-label", "triage/"+*cur.Triage)
	}
	_, err = g.gh(args...)
	return err
}

func (g *GitHubBackend) SetBlocking(mapSlug, ticketID string, blockedBy []string) error {
	id := remoteID(ticketID)
	cur, err := g.GetTicket(mapSlug, id)
	if err != nil {
		return err
	}
	newBody := buildBodyWithBlockers(cur.Body, blockedBy)
	_, err = g.gh("issue", "edit", id, "-R", g.repo, "--body", newBody)
	return err
}

func (g *GitHubBackend) Frontier(mapSlug string) ([]TicketSummary, error) {
	all, err := g.ListTickets(mapSlug, ListFilter{})
	if err != nil {
		return nil, err
	}
	return ComputeFrontier(all), nil
}

func (g *GitHubBackend) CloseVerify(opts CloseVerifyOpts) (CloseVerifyReport, error) {
	src, err := g.closeVerifySource(opts.Ref)
	if err != nil {
		return CloseVerifyReport{}, err
	}
	return runCloseVerify(g, "", src, opts)
}

// closeVerifySource collects every free-text that may carry closing patterns:
// the PR body plus all commit messages (headline+body), or the single commit
// message for a SHA. The full commit sweep is the point — the platform only
// auto-closes from the default-branch merge and takes refs piecemeal.
func (g *GitHubBackend) closeVerifySource(ref string) (closeSource, error) {
	if isIssueNumber(ref) {
		var pr struct {
			Number  int    `json:"number"`
			Title   string `json:"title"`
			State   string `json:"state"`
			URL     string `json:"url"`
			Body    string `json:"body"`
			Commits []struct {
				MessageHeadline string `json:"messageHeadline"`
				MessageBody     string `json:"messageBody"`
			} `json:"commits"`
		}
		if err := g.ghJSON(&pr, "pr", "view", ref, "-R", g.repo,
			"--json", "number,title,state,url,body,commits"); err != nil {
			return closeSource{}, err
		}
		src := closeSource{
			Source: fmt.Sprintf("pr #%d", pr.Number),
			URL:    pr.URL,
			Texts:  []string{pr.Title + "\n" + pr.Body},
		}
		for _, c := range pr.Commits {
			src.Texts = append(src.Texts, c.MessageHeadline+"\n"+c.MessageBody)
		}
		return src, nil
	}

	// Otherwise treat ref as a merge/commit SHA.
	var commit struct {
		HTMLURL string `json:"html_url"`
		Commit  struct {
			Message string `json:"message"`
		} `json:"commit"`
	}
	if err := g.ghJSON(&commit, "api", "repos/"+g.repo+"/commits/"+ref); err != nil {
		return closeSource{}, errors.Wrapf(ErrNotFound, "commit %q not found in %s", ref, g.repo)
	}
	return closeSource{
		Source: "commit " + shortSHA(ref),
		URL:    commit.HTMLURL,
		Texts:  []string{commit.Commit.Message},
	}, nil
}

func isIssueNumber(ref string) bool {
	_, err := strconv.Atoi(ref)
	return err == nil
}

func shortSHA(ref string) string {
	if len(ref) > 12 {
		return ref[:12]
	}
	return ref
}
