package tracker

import (
	"bytes"
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

// perPage is the page size every paginated GitLab list request uses. A
// full page with NO x-next-page header means pagination is degraded (glab
// didn't expose the header) — we fail loudly rather than silently
// truncating (ocr re-review M'4; the silent variant was the original M3).
const perPage = 100

// apiJSONAll fetches every page of a list endpoint, following the
// x-next-page header. Without it, results stop at the first page (100
// items) and silently truncate — ListMaps misses maps, frontier/blocker
// decisions run on incomplete data (ocr M3). Pages are joined and decoded
// once; non-array output fails loudly at the outer unmarshal.
func (gl *GitLabBackend) apiJSONAll(v any, endpoint string) error {
	var pages [][]byte
	url := endpoint
	for url != "" && len(pages) < 100 { // hard cap: 10k items
		stdout, stderr, err := gl.runCapture(url)
		if err != nil {
			return errors.Wrapf(err, "glab api %s: %s", url, strings.TrimSpace(stderr))
		}
		pages = append(pages, stdout)
		if n := nextPage(stderr); n != "" {
			// x-next-page is a page NUMBER; append as the page param.
			sep := "?"
			if strings.Contains(endpoint, "?") {
				sep = "&"
			}
			url = endpoint + sep + "page=" + n
			continue
		}
		// No header. A full page means we likely stopped early.
		if n := countJSONElements(pages[len(pages)-1]); n >= perPage {
			return errors.Wrapf(ErrInvalidInput,
				"gitlab list returned a full %d-element page with no x-next-page header — pagination unavailable (degraded glab output?), refusing to silently truncate; narrow the query or upgrade glab", n)
		}
		url = ""
	}
	joined := make([]byte, 0, 2)
	joined = append(joined, '[')
	for i, el := range pages {
		if i > 0 {
			joined = append(joined, ',')
		}
		joined = append(joined, trimArray(el)...) // every page is an array
	}
	joined = append(joined, ']')
	return json.Unmarshal(joined, v)
}

// trimArray strips the enclosing brackets of a JSON array page. Empty or
// non-array pages yield "" so the join never produces invalid JSON like
// "[,]" (ocr re-review M'4).
func trimArray(b []byte) []byte {
	b = bytes.TrimSpace(b)
	if len(b) >= 2 && b[0] == '[' && b[len(b)-1] == ']' {
		inner := bytes.TrimSpace(b[1 : len(b)-1])
		return inner
	}
	return nil
}

// countJSONElements counts top-level elements of a JSON array page.
func countJSONElements(page []byte) int {
	var els []json.RawMessage
	if err := json.Unmarshal(page, &els); err != nil {
		return 0
	}
	return len(els)
}

// runCapture runs one glab api page, returning stdout plus the stderr text
// (glab api prints the x-next-page pagination header there as diagnostics).
func (gl *GitLabBackend) runCapture(endpoint string) (stdout []byte, stderrText string, err error) {
	out, stderr, err := AsStderrRunner(gl.run).RunStderr(gl.env(), "glab", "api", endpoint)
	if err != nil {
		return out, stderr, errors.Wrapf(err, "glab api %s", endpoint)
	}
	return out, stderr, nil
}

// nextPage extracts the x-next-page value from glab api's stderr line
// "x-next-page: 2" (glab prints response headers as diagnostics when
// stderr is a TTY — with hooks below we capture them regardless).
func nextPage(stderr string) string {
	for _, line := range strings.Split(stderr, "\n") {
		idx := strings.Index(line, ":")
		if idx <= 0 {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(line[:idx]), "x-next-page") {
			v := strings.TrimSpace(line[idx+1:])
			if v != "" {
				return v
			}
		}
	}
	return ""
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
	if err := gl.apiJSONAll(&labels, gl.projectEndpoint("labels?per_page=100")); err != nil {
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
	if opts.BlockedBy == nil {
		opts.BlockedBy = []string{}
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
	if err := gl.apiJSONAll(&issues, endpoint); err != nil {
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
		// GitLab returns {"message":"404 Not found"} for missing issues.
		// Match the specific body text: a bare "404" would also swallow
		// unrelated errors that merely contain the digits (ocr re-review M'3).
		if strings.Contains(err.Error(), "404 Not Found") || strings.Contains(err.Error(), "404 Not found") {
			return TicketDetail{}, errors.Wrapf(ErrNotFound, "issue #%s not found in %s", remoteID(ticketID), gl.repo)
		}
		return TicketDetail{}, err
	}
	var notes []glNote
	if err := gl.apiJSONAll(&notes, gl.projectEndpoint(fmt.Sprintf("issues/%s/notes?per_page=100&sort=asc", remoteID(ticketID)))); err != nil {
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

	cur, err := gl.GetTicket(mapSlug, id)
	if err != nil {
		return err
	}

	// Claim guards mirror the local contract (status.go), same as GitHub (ocr M7).
	if status == "claimed" {
		if cur.Status == "resolved" {
			return errors.Wrapf(ErrAlreadyResolved, "issue #%s is already resolved — reopen it first", id)
		}
		if cur.Status == "claimed" {
			return errors.Wrapf(ErrAlreadyClaimed, "issue #%s is already claimed", id)
		}
		_, err := gl.api(gl.projectEndpoint("issues/"+id),
			"-X", "PUT", "-f", "add_labels=status/claimed")
		return err
	}

	if status == "resolved" {
		if cur.Status == "resolved" {
			return nil
		}
		// Single atomic PUT: GitLab accepts state_event and remove_labels in
		// one request, avoiding a half-done transition when step 1 of 2 fails
		// (ocr M2). GitHub has no equivalent and stays two-step.
		args := []string{"-X", "PUT", "-f", "state_event=close"}
		if cur.Status == "claimed" {
			args = append(args, "-f", "remove_labels=status/claimed")
		}
		_, err := gl.api(gl.projectEndpoint("issues/"+id), args...)
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
	src, err := gl.closeVerifySource(opts.Ref, opts.Apply)
	if err != nil {
		return CloseVerifyReport{}, err
	}
	return runCloseVerify(gl, "", src, opts)
}

func (gl *GitLabBackend) closeVerifySource(ref string, apply bool) (closeSource, error) {
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
		// --apply closes tickets; only a merged MR is closure evidence (H4/H5).
		if apply && mr.State != "merged" {
			return closeSource{}, errors.Wrapf(ErrInvalidInput,
				"MR !%d is %q, not merged — --apply refuses to close tickets from an unmerged MR (dry-run is still available)", mr.IID, mr.State)
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
	// Same gate as the MR path: only commits that landed on the default
	// branch are closure evidence (ocr re-review H4-residual). GitLab has no
	// direct "merged" flag on commits; a commit is merged evidence iff some
	// MERGED merge request contains it (merge_requests?sha=<ref>).
	if apply {
		var mrs []struct {
			IID   int    `json:"iid"`
			State string `json:"state"`
		}
		if err := gl.apiJSONAll(&mrs, gl.projectEndpoint(fmt.Sprintf(
			"merge_requests?state=all&sha=%s&per_page=100", commit.ID))); err != nil {
			return closeSource{}, errors.Wrapf(err, "checking %q reachability (merge requests containing it)", shortSHA(commit.ID))
		}
		merged := false
		for _, mr := range mrs {
			if mr.State == "merged" {
				merged = true
				break
			}
		}
		if !merged {
			return closeSource{}, errors.Wrapf(ErrInvalidInput,
				"commit %s has no merged merge request — --apply refuses to close tickets from an unmerged commit (dry-run is still available)",
				shortSHA(commit.ID))
		}
	}
	return closeSource{
		Source: "commit " + shortSHA(commit.ID),
		URL:    commit.WebURL,
		Texts:  []string{commit.Message},
	}, nil
}
