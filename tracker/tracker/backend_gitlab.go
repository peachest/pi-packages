package tracker

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/errors"
)

// GitLabBackend implements Backend by shelling out to `glab api` — raw
// GitLab REST JSON. glab's per-command human/JSON output formats vary too
// much between versions, so everything goes through the `api` passthrough.
//
// GitLab auto-creates labels on issue create/update, so unlike GitHub there
// is no ensureLabel step.
type GitLabBackend struct {
	run  Runner
	repo string
	host string // optional GITLAB_HOST override; empty = glab config default
}

func NewGitLabBackend(run Runner, repo, host string) *GitLabBackend {
	return &GitLabBackend{run: run, repo: repo, host: host}
}

func (gl *GitLabBackend) env() []string {
	if gl.host == "" {
		return nil
	}
	return []string{"GITLAB_HOST=" + gl.host}
}

// api runs `glab api` against an endpoint. The repo path is URL-encoded once
// ("group/project" → "group%2Fproject") for use inside project-scoped
// endpoints.
func (gl *GitLabBackend) api(endpoint string, extraArgs ...string) ([]byte, error) {
	args := append([]string{"api", endpoint}, extraArgs...)
	out, err := gl.run.Run(gl.env(), "glab", args...)
	if err != nil {
		return nil, errors.Wrapf(err, "glab api %s", endpoint)
	}
	return out, nil
}

func (gl *GitLabBackend) apiJSON(v any, endpoint string, extraArgs ...string) error {
	out, err := gl.api(endpoint, extraArgs...)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(out, v); err != nil {
		return errors.Wrapf(err, "parsing glab output: %s", endpoint)
	}
	return nil
}

func (gl *GitLabBackend) enc() string { return strings.ReplaceAll(gl.repo, "/", "%2F") }

func (gl *GitLabBackend) projectEndpoint(path string) string {
	return fmt.Sprintf("projects/%s/%s", gl.enc(), path)
}

type glIssue struct {
	IID         int       `json:"iid"`
	Title       string    `json:"title"`
	State       string    `json:"state"` // "opened" | "closed"
	Labels      []string  `json:"labels"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	WebURL      string    `json:"web_url"`
}

type glNote struct {
	System bool   `json:"system"`
	Body   string `json:"body"`
	Author struct {
		Username string `json:"username"`
	} `json:"author"`
	CreatedAt time.Time `json:"created_at"`
}

// glIssueToSummary maps a GitLab issue onto the shared vocabulary. Status:
// closed → resolved; opened + label status/claimed → claimed; else open.
func glIssueToSummary(issue glIssue, mapSlug string) TicketSummary {
	status := "open"
	if issue.State == "closed" {
		status = "resolved"
	} else {
		for _, l := range issue.Labels {
			if l == "status/claimed" {
				status = "claimed"
			}
		}
	}
	var triage *string
	var typ string
	for _, l := range issue.Labels {
		if v, ok := strings.CutPrefix(l, "triage/"); ok {
			triage = &v
		}
		if v, ok := strings.CutPrefix(l, "type/"); ok {
			typ = v
		}
	}
	return TicketSummary{
		ID:        strconv.Itoa(issue.IID),
		Title:     issue.Title,
		Map:       mapSlug,
		Type:      typ,
		Status:    status,
		Triage:    triage,
		BlockedBy: parseBlockedBy(issue.Description),
		Path:      issue.WebURL,
		CreatedAt: issue.CreatedAt,
	}
}

type glLabel struct {
	Name string `json:"name"`
}

func (gl *GitLabBackend) ListMaps() ([]MapSummary, error) {
	var labels []glLabel
	if err := gl.apiJSON(&labels, gl.projectEndpoint("labels?per_page=100")); err != nil {
		return nil, err
	}
	var maps []MapSummary
	for _, l := range labels {
		if slug, ok := strings.CutPrefix(l.Name, "map/"); ok {
			maps = append(maps, MapSummary{Slug: slug, Title: slug, State: "active"})
		}
	}
	if maps == nil {
		maps = []MapSummary{}
	}
	return maps, nil
}

func (gl *GitLabBackend) CreateTicket(opts TicketOpts) (TicketSummary, error) {
	if err := validateTicketOpts(opts); err != nil {
		return TicketSummary{}, err
	}
	labels := []string{mapLabel(opts.MapSlug), "type/" + opts.Type}
	if opts.Triage != nil {
		labels = append(labels, "triage/"+*opts.Triage)
	}
	body := buildBodyWithBlockers("", opts.BlockedBy)

	var created glIssue
	if err := gl.apiJSON(&created, gl.projectEndpoint("issues"),
		"-X", "POST",
		"-f", "title="+opts.Title,
		"-f", "description="+body,
		"-f", "labels="+strings.Join(labels, ",")); err != nil {
		return TicketSummary{}, err
	}
	return TicketSummary{
		ID:        strconv.Itoa(created.IID),
		Title:     opts.Title,
		Map:       opts.MapSlug,
		Type:      opts.Type,
		Status:    "open",
		Triage:    opts.Triage,
		BlockedBy: opts.BlockedBy,
		Path:      created.WebURL,
		CreatedAt: time.Now().UTC(),
	}, nil
}

func (gl *GitLabBackend) ListTickets(mapSlug string, filter ListFilter) ([]TicketSummary, error) {
	endpoint := gl.projectEndpoint("issues?state=all&per_page=100&labels=" + mapLabel(mapSlug))
	if filter.Type != "" {
		// GitLab labels param is comma-separated; additional label ANDs.
		endpoint += ",type/" + filter.Type
	}
	var issues []glIssue
	if err := gl.apiJSON(&issues, endpoint); err != nil {
		return nil, err
	}
	var tickets []TicketSummary
	for _, issue := range issues {
		t := glIssueToSummary(issue, mapSlug)
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

func (gl *GitLabBackend) GetTicket(mapSlug, ticketID string) (TicketDetail, error) {
	var issue glIssue
	if err := gl.apiJSON(&issue, gl.projectEndpoint("issues/"+remoteID(ticketID))); err != nil {
		// GitLab returns 404 JSON {"message":"404 Not found"} for missing issues.
		if strings.Contains(err.Error(), "404") {
			return TicketDetail{}, errors.Wrapf(ErrNotFound, "issue #%s not found in %s", remoteID(ticketID), gl.repo)
		}
		return TicketDetail{}, err
	}
	var notes []glNote
	if err := gl.apiJSON(&notes, gl.projectEndpoint(fmt.Sprintf("issues/%s/notes?per_page=100&sort=asc", remoteID(ticketID)))); err != nil {
		return TicketDetail{}, err
	}
	detail := TicketDetail{TicketSummary: glIssueToSummary(issue, mapSlug)}
	for _, n := range notes {
		if n.System {
			continue // state-change/system notes are not user comments
		}
		detail.Comments = append(detail.Comments, TicketComment{
			Author:    n.Author.Username,
			CreatedAt: n.CreatedAt,
			Body:      n.Body,
		})
	}
	detail.Body = issue.Description
	return detail, nil
}

func (gl *GitLabBackend) AddComment(mapSlug, ticketID, body string) error {
	_, err := gl.api(gl.projectEndpoint(fmt.Sprintf("issues/%s/notes", remoteID(ticketID))),
		"-X", "POST", "-f", "body="+body)
	return err
}

func (gl *GitLabBackend) SetStatus(mapSlug, ticketID, status string) error {
	if err := validateStatus(status); err != nil {
		return err
	}
	id := remoteID(ticketID)

	if status == "claimed" {
		_, err := gl.api(gl.projectEndpoint("issues/"+id),
			"-X", "PUT", "-f", "add_labels=status/claimed")
		return err
	}

	cur, err := gl.GetTicket(mapSlug, id)
	if err != nil {
		return err
	}
	if status == "resolved" {
		if cur.Status == "resolved" {
			return nil
		}
		_, err := gl.api(gl.projectEndpoint("issues/"+id), "-X", "PUT", "-f", "state_event=close")
		return err
	}
	// status == "open"
	if cur.Status == "open" {
		return nil
	}
	args := []string{"-X", "PUT"}
	if cur.Status == "claimed" {
		args = append(args, "-f", "remove_labels=status/claimed")
	}
	if cur.Status == "resolved" {
		args = append(args, "-f", "state_event=reopen")
	}
	_, err = gl.api(gl.projectEndpoint("issues/"+id), args...)
	return err
}

func (gl *GitLabBackend) SetTriage(mapSlug, ticketID, triage string) error {
	if !inList(validTriages, triage) {
		return errors.Wrapf(ErrInvalidInput, "invalid triage %q, valid values: %v", triage, validTriages)
	}
	id := remoteID(ticketID)
	cur, err := gl.GetTicket(mapSlug, id)
	if err != nil {
		return err
	}
	args := []string{"-X", "PUT", "-f", "add_labels=triage/" + triage}
	if cur.Triage != nil && *cur.Triage != triage {
		args = append(args, "-f", "remove_labels=triage/"+*cur.Triage)
	}
	_, err = gl.api(gl.projectEndpoint("issues/"+id), args...)
	return err
}

func (gl *GitLabBackend) SetBlocking(mapSlug, ticketID string, blockedBy []string) error {
	id := remoteID(ticketID)
	cur, err := gl.GetTicket(mapSlug, id)
	if err != nil {
		return err
	}
	newBody := buildBodyWithBlockers(cur.Body, blockedBy)
	_, err = gl.api(gl.projectEndpoint("issues/"+id), "-X", "PUT", "-f", "description="+newBody)
	return err
}

func (gl *GitLabBackend) Frontier(mapSlug string) ([]TicketSummary, error) {
	all, err := gl.ListTickets(mapSlug, ListFilter{})
	if err != nil {
		return nil, err
	}
	return ComputeFrontier(all), nil
}

func (gl *GitLabBackend) CloseVerify(opts CloseVerifyOpts) (CloseVerifyReport, error) {
	src, err := gl.closeVerifySource(opts.Ref)
	if err != nil {
		return CloseVerifyReport{}, err
	}
	return runCloseVerify(gl, "", src, opts)
}

func (gl *GitLabBackend) closeVerifySource(ref string) (closeSource, error) {
	if isIssueNumber(ref) {
		var mr struct {
			IID         int    `json:"iid"`
			Title       string `json:"title"`
			State       string `json:"state"`
			Description string `json:"description"`
			WebURL      string `json:"web_url"`
		}
		if err := gl.apiJSON(&mr, gl.projectEndpoint("merge_requests/"+ref)); err != nil {
			return closeSource{}, err
		}
		var commits []struct {
			Message string `json:"message"`
		}
		if err := gl.apiJSON(&commits, gl.projectEndpoint(fmt.Sprintf("merge_requests/%s/commits?per_page=100", ref))); err != nil {
			return closeSource{}, err
		}
		src := closeSource{
			Source: fmt.Sprintf("mr !%d", mr.IID),
			URL:    mr.WebURL,
			Texts:  []string{mr.Title + "\n" + mr.Description},
		}
		for _, c := range commits {
			src.Texts = append(src.Texts, c.Message)
		}
		return src, nil
	}

	var commit struct {
		ID      string `json:"id"`
		Message string `json:"message"`
		WebURL  string `json:"web_url"`
	}
	if err := gl.apiJSON(&commit, gl.projectEndpoint("repository/commits/"+ref)); err != nil {
		return closeSource{}, errors.Wrapf(ErrNotFound, "commit %q not found in %s", ref, gl.repo)
	}
	return closeSource{
		Source: "commit " + shortSHA(commit.ID),
		URL:    commit.WebURL,
		Texts:  []string{commit.Message},
	}, nil
}
