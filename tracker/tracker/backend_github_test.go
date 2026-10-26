package tracker

import (
	"fmt"
	"strings"
	"testing"
)

// fakeRunner records every command and returns canned output keyed by the
// full command string. Unmatched commands fail the test via error.
type fakeRunner struct {
	calls     []string
	responses map[string]string
}

func (f *fakeRunner) Run(_ []string, name string, args ...string) ([]byte, error) {
	key := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, key)
	if out, ok := f.responses[key]; ok {
		return []byte(out), nil
	}
	return nil, fmt.Errorf("fakeRunner: unexpected command: %s", key)
}

func ghListIssue(number int, state string, labels []string, body string) string {
	lbls := make([]string, len(labels))
	for i, l := range labels {
		lbls[i] = fmt.Sprintf(`{"name":%q}`, l)
	}
	return fmt.Sprintf(`{"number":%d,"title":"t%d","state":%q,"labels":[%s],"body":%q,"createdAt":"2026-01-01T00:00:00Z","url":"https://github.com/o/r/issues/%d"}`,
		number, number, state, strings.Join(lbls, ","), body, number)
}

func TestGitHubListTicketsMapping(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{
		"gh issue list -R o/r --state all --label map/way --limit 1000 --json number,title,state,labels,body,createdAt,url": "[" +
			ghListIssue(1, "OPEN", []string{"map/way", "type/task"}, "") + "," +
			ghListIssue(2, "OPEN", []string{"map/way", "type/task", "status/claimed", "triage/ready-for-agent"}, "") + "," +
			ghListIssue(3, "CLOSED", []string{"map/way", "type/task"}, "") + "," +
			ghListIssue(4, "OPEN", []string{"map/way", "type/task"}, "Blocked by: #1, #3\n\nbody") +
			"]",
	}}
	b := NewGitHubBackend(r, "o/r")

	tickets, err := b.ListTickets("way", ListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(tickets) != 4 {
		t.Fatalf("got %d tickets, want 4", len(tickets))
	}
	if tickets[0].Status != "open" {
		t.Errorf("issue 1 status = %q, want open", tickets[0].Status)
	}
	if tickets[1].Status != "claimed" {
		t.Errorf("issue 2 status = %q, want claimed (open + status/claimed label)", tickets[1].Status)
	}
	if tickets[2].Status != "resolved" {
		t.Errorf("issue 3 status = %q, want resolved (CLOSED)", tickets[2].Status)
	}
	if tickets[1].Triage == nil || *tickets[1].Triage != "ready-for-agent" {
		t.Errorf("issue 2 triage = %v, want ready-for-agent", tickets[1].Triage)
	}
	if tickets[1].Type != "task" {
		t.Errorf("issue 2 type = %q, want task", tickets[1].Type)
	}
	wantBlockers := []string{"1", "3"}
	if fmt.Sprint(tickets[3].BlockedBy) != fmt.Sprint(wantBlockers) {
		t.Errorf("issue 4 blocked_by = %v, want %v", tickets[3].BlockedBy, wantBlockers)
	}
}

func TestGitHubCreateTicket(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{
		"gh issue create -R o/r --title Fix it --body Blocked by: #3 --label map/way,type/task,triage/ready-for-agent": "https://github.com/o/r/issues/7\n",
		"gh label create map/way -R o/r":                "",
		"gh label create type/task -R o/r":              "",
		"gh label create triage/ready-for-agent -R o/r": "",
	}}
	b := NewGitHubBackend(r, "o/r")

	triage := "ready-for-agent"
	ticket, err := b.CreateTicket(TicketOpts{MapSlug: "way", Title: "Fix it", Type: "task", Triage: &triage, BlockedBy: []string{"3"}})
	if err != nil {
		t.Fatal(err)
	}
	if ticket.ID != "7" {
		t.Errorf("ID = %q, want 7", ticket.ID)
	}
	if ticket.Status != "open" || ticket.BlockedBy[0] != "3" {
		t.Errorf("unexpected ticket: %+v", ticket)
	}
	// blocked-by marker must be in the body and triage label requested
	joined := strings.Join(r.calls, "\n")
	if !strings.Contains(joined, "--body Blocked by: #3") {
		t.Errorf("create call missing blocked-by marker body:\n%s", joined)
	}
	if !strings.Contains(joined, "triage/ready-for-agent") {
		t.Errorf("create call missing triage label:\n%s", joined)
	}
}

// singleIssueJSON returns one gh issue view --json object.
func singleIssueJSON(number int, state string, labels []string, body string) string {
	return ghListIssue(number, state, labels, body)
}

func TestGitHubSetStatusResolvedCloses(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{
		"gh issue view 5 -R o/r --json number,title,state,labels,body,createdAt,url,comments": singleIssueJSON(5, "OPEN", []string{"map/way"}, ""),
		"gh issue close 5 -R o/r": "",
	}}
	b := NewGitHubBackend(r, "o/r")
	if err := b.SetStatus("way", "5", "resolved"); err != nil {
		t.Fatal(err)
	}
	last := r.calls[len(r.calls)-1]
	if !strings.Contains(last, "issue close 5") {
		t.Errorf("expected gh issue close, got: %s", last)
	}
}

func TestGitHubSetStatusClaimedAddsLabel(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{
		"gh issue view 5 -R o/r --json number,title,state,labels,body,createdAt,url,comments": singleIssueJSON(5, "OPEN", []string{"map/way"}, ""),
		"gh label create status/claimed -R o/r":                                               "",
		"gh issue edit 5 -R o/r --add-label status/claimed":                                   "",
	}}
	b := NewGitHubBackend(r, "o/r")
	if err := b.SetStatus("way", "5", "claimed"); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(r.calls, "\n")
	if !strings.Contains(joined, "--add-label status/claimed") {
		t.Errorf("expected add-label status/claimed:\n%s", joined)
	}
}

func TestGitHubFrontierUsesSharedFilter(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{
		"gh issue list -R o/r --state all --label map/way --limit 1000 --json number,title,state,labels,body,createdAt,url": "[" +
			ghListIssue(1, "OPEN", []string{"map/way", "triage/ready-for-agent"}, "") + "," +
			ghListIssue(2, "OPEN", []string{"map/way"}, "Blocked by: #1") + "," +
			ghListIssue(3, "OPEN", []string{"map/way", "triage/needs-triage"}, "") +
			"]",
	}}
	b := NewGitHubBackend(r, "o/r")
	frontier, err := b.Frontier("way")
	if err != nil {
		t.Fatal(err)
	}
	// #1 ready; #2 blocked by open #1; #3 triaged out.
	if len(frontier) != 1 || frontier[0].ID != "1" {
		t.Errorf("frontier = %v, want [#1]", frontier)
	}
}

func TestGitHubCloseVerifyDryRun(t *testing.T) {
	prJSON := `{"number":9,"title":"feat","state":"MERGED","mergedAt":"2026-10-20T00:00:00Z","url":"https://github.com/o/r/pull/9","body":"Closes #1, #2","commits":[
		{"oid":"a1","messageHeadline":"part","messageBody":"fixes #3"},
		{"oid":"a2","messageHeadline":"no refs here","messageBody":"just text"}
	]}`
	issue := func(n int, state string) string {
		return singleIssueJSON(n, state, []string{"map/way"}, "")
	}
	r := &fakeRunner{responses: map[string]string{
		"gh pr view 9 -R o/r --json number,title,state,mergedAt,url,body,commits":             prJSON,
		"gh issue view 1 -R o/r --json number,title,state,labels,body,createdAt,url,comments": issue(1, "CLOSED"),
		"gh issue view 2 -R o/r --json number,title,state,labels,body,createdAt,url,comments": issue(2, "OPEN"),
		"gh issue view 3 -R o/r --json number,title,state,labels,body,createdAt,url,comments": issue(3, "OPEN"),
	}}
	b := NewGitHubBackend(r, "o/r")

	report, err := b.CloseVerify(CloseVerifyOpts{Ref: "9"})
	if err != nil {
		t.Fatal(err)
	}
	if report.Source != "pr #9" {
		t.Errorf("source = %q, want pr #9", report.Source)
	}
	if len(report.Refs) != 3 {
		t.Fatalf("refs = %+v, want 3", report.Refs)
	}
	if !report.Refs[0].Closed || report.Refs[1].Closed || report.Refs[2].Closed {
		t.Errorf("closed flags wrong: %+v", report.Refs)
	}
	if len(report.Applied) != 0 {
		t.Errorf("dry-run must not apply, got %v", report.Applied)
	}
	// dry-run: no writes
	joined := strings.Join(r.calls, "\n")
	if strings.Contains(joined, "issue close") || strings.Contains(joined, "issue comment") {
		t.Errorf("dry-run performed writes:\n%s", joined)
	}
}

func TestGitHubCloseVerifyApply(t *testing.T) {
	prJSON := `{"number":9,"title":"feat","state":"MERGED","mergedAt":"2026-10-20T00:00:00Z","url":"https://github.com/o/r/pull/9","body":"Closes #2","commits":[]}`
	r := &fakeRunner{responses: map[string]string{
		"gh pr view 9 -R o/r --json number,title,state,mergedAt,url,body,commits":                                                             prJSON,
		"gh issue view 2 -R o/r --json number,title,state,labels,body,createdAt,url,comments":                                                 singleIssueJSON(2, "OPEN", []string{"map/way"}, ""),
		"gh issue comment 2 -R o/r --body Closed by pr #9 (https://github.com/o/r/pull/9). Verified automatically by `tracker close-verify`.": "",
		"gh issue close 2 -R o/r": "",
	}}
	b := NewGitHubBackend(r, "o/r")

	report, err := b.CloseVerify(CloseVerifyOpts{Ref: "9", Apply: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Applied) != 1 || report.Applied[0] != "2" {
		t.Errorf("applied = %v, want [2]", report.Applied)
	}
	joined := strings.Join(r.calls, "\n")
	if !strings.Contains(joined, "issue comment 2") || !strings.Contains(joined, "issue close 2") {
		t.Errorf("apply must comment+close:\n%s", joined)
	}
}

func TestGitHubCloseVerifyBySHA(t *testing.T) {
	commitJSON := `{"html_url":"https://github.com/o/r/commit/abc","commit":{"message":"merge: Closes #4"}}`
	r := &fakeRunner{responses: map[string]string{
		"gh api repos/o/r/commits/abcdef123456":                                               commitJSON,
		"gh issue view 4 -R o/r --json number,title,state,labels,body,createdAt,url,comments": singleIssueJSON(4, "OPEN", []string{}, ""),
	}}
	b := NewGitHubBackend(r, "o/r")
	report, err := b.CloseVerify(CloseVerifyOpts{Ref: "abcdef123456"})
	if err != nil {
		t.Fatal(err)
	}
	if report.Source != "commit abcdef123456" || len(report.Refs) != 1 || report.Refs[0].Issue != "4" {
		t.Errorf("unexpected report: %+v", report)
	}
}

func TestParseBlockedBy(t *testing.T) {
	tests := []struct {
		body string
		want []string
	}{
		{"Blocked by: #1, #2\n\nrest", []string{"1", "2"}},
		{"no marker", []string{}},
		{"some text\nBlocked by: #3\nmore", []string{"3"}},
		{"Blocked by:", []string{}},
	}
	for _, tt := range tests {
		got := parseBlockedBy(tt.body)
		if fmt.Sprint(got) != fmt.Sprint(tt.want) {
			t.Errorf("parseBlockedBy(%q) = %v, want %v", tt.body, got, tt.want)
		}
	}
}

func TestBuildBodyWithBlockers(t *testing.T) {
	if got := buildBodyWithBlockers("body", []string{"1", "02"}); got != "Blocked by: #1, #2\n\nbody" {
		t.Errorf("got %q", got)
	}
	if got := buildBodyWithBlockers("Blocked by: #9\n\nbody", []string{}); got != "body" {
		t.Errorf("marker not removed: %q", got)
	}
	if got := buildBodyWithBlockers("", nil); got != "" {
		t.Errorf("got %q", got)
	}
}

func TestGitHubCloseVerifyApplyRefusesUnmergedPR(t *testing.T) {
	prJSON := `{"number":9,"title":"wip","state":"OPEN","mergedAt":null,"url":"https://github.com/o/r/pull/9","body":"Closes #2","commits":[]}`
	r := &fakeRunner{responses: map[string]string{
		"gh pr view 9 -R o/r --json number,title,state,mergedAt,url,body,commits":             prJSON,
		"gh issue view 2 -R o/r --json number,title,state,labels,body,createdAt,url,comments": singleIssueJSON(2, "OPEN", []string{}, ""),
	}}
	b := NewGitHubBackend(r, "o/r")

	// apply + unmerged → refused, no writes
	_, err := b.CloseVerify(CloseVerifyOpts{Ref: "9", Apply: true})
	if !isErr(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}
	if strings.Contains(strings.Join(r.calls, "\n"), "issue close") {
		t.Errorf("refused run must not write")
	}

	// dry-run + unmerged → allowed, read-only report
	report, err := b.CloseVerify(CloseVerifyOpts{Ref: "9"})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Refs) != 1 || report.Refs[0].Issue != "2" {
		t.Errorf("dry-run refs = %+v", report.Refs)
	}
}

func TestGitHubCloseVerifyApplyRefusesUnreachableSHA(t *testing.T) {
	commitJSON := `{"html_url":"https://github.com/o/r/commit/abc","commit":{"message":"merge: Closes #4"}}`
	r := &fakeRunner{responses: map[string]string{
		"gh api repos/o/r/commits/abc123": commitJSON,
		"gh api repos/o/r":                `{"default_branch":"main"}`,
		// compare main...abc123 intentionally absent → 404 → unreachable
	}}
	b := NewGitHubBackend(r, "o/r")
	// compare 404 (not in responses → fakeRunner errors) == unreachable:
	// apply refused, dry-run allowed
	_, err := b.CloseVerify(CloseVerifyOpts{Ref: "abc123", Apply: true})
	if !isErr(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}
	r.responses["gh issue view 4 -R o/r --json number,title,state,labels,body,createdAt,url,comments"] = singleIssueJSON(4, "OPEN", []string{}, "")
	report, err := b.CloseVerify(CloseVerifyOpts{Ref: "abc123"})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Refs) != 1 || report.Refs[0].Issue != "4" {
		t.Errorf("dry-run refs = %+v", report.Refs)
	}
}

func TestGitHubCloseVerifyApplyAllowsMergedSHA(t *testing.T) {
	commitJSON := `{"html_url":"https://github.com/o/r/commit/abc","commit":{"message":"merge: Closes #4"}}`
	r := &fakeRunner{responses: map[string]string{
		"gh api repos/o/r/commits/abc123":        commitJSON,
		"gh api repos/o/r":                       `{"default_branch":"main"}`,
		"gh api repos/o/r/compare/main...abc123": `{"status":"behind"}`,
		"gh issue view 4 -R o/r --json number,title,state,labels,body,createdAt,url,comments":                                                             singleIssueJSON(4, "OPEN", []string{}, ""),
		"gh issue comment 4 -R o/r --body Closed by commit abc123 (https://github.com/o/r/commit/abc). Verified automatically by `tracker close-verify`.": "",
		"gh issue close 4 -R o/r": "",
	}}
	b := NewGitHubBackend(r, "o/r")
	report, err := b.CloseVerify(CloseVerifyOpts{Ref: "abc123", Apply: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Applied) != 1 || report.Applied[0] != "4" {
		t.Errorf("applied = %v, want [4]", report.Applied)
	}
}
