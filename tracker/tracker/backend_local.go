package tracker

import (
	"os"
	"strings"
	"time"

	"github.com/pkg/errors"
)

// LocalBackend implements Backend on top of the original .scratch/ markdown
// storage, wrapping the package functions 1:1 — behavior is identical to
// calling them directly (fully backward compatible).
type LocalBackend struct {
	cwd string
}

func NewLocalBackend(cwd string) *LocalBackend { return &LocalBackend{cwd: cwd} }

func (l *LocalBackend) withRoot(fn func(root *os.Root) error) error {
	scratchDir, err := EnsureScratchDir(l.cwd)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(scratchDir)
	if err != nil {
		return errors.Wrapf(err, "opening scratch root %s", scratchDir)
	}
	defer root.Close()
	return fn(root)
}

func (l *LocalBackend) ListMaps() ([]MapSummary, error) {
	var maps []MapSummary
	err := l.withRoot(func(root *os.Root) error {
		var err error
		maps, err = ListMaps(root)
		return err
	})
	return maps, err
}

func (l *LocalBackend) CreateTicket(opts TicketOpts) (TicketSummary, error) {
	var ticket TicketSummary
	err := l.withRoot(func(root *os.Root) error {
		var err error
		ticket, err = CreateTicket(root, opts, time.Now().UTC())
		return err
	})
	return ticket, err
}

func (l *LocalBackend) ListTickets(mapSlug string, filter ListFilter) ([]TicketSummary, error) {
	var tickets []TicketSummary
	err := l.withRoot(func(root *os.Root) error {
		var err error
		tickets, err = ListTickets(root, mapSlug, filter)
		return err
	})
	return tickets, err
}

// GetTicket returns front matter + file body. Comments is nil: local comments
// are plain markdown lines inside the body's "## Comments" section (G4).
func (l *LocalBackend) GetTicket(mapSlug, ticketID string) (TicketDetail, error) {
	var detail TicketDetail
	err := l.withRoot(func(root *os.Root) error {
		path, fm, err := ReadTicketForDisplay(root, mapSlug, ticketID)
		if err != nil {
			return err
		}
		data, err := root.ReadFile(path)
		if err != nil {
			return errors.Wrapf(err, "reading ticket file")
		}
		detail = TicketDetail{
			TicketSummary: TicketSummary{
				ID:        fm.ID,
				Title:     fm.Title,
				Map:       mapSlug,
				Type:      fm.Type,
				Status:    fm.Status,
				Triage:    fm.Triage,
				BlockedBy: fm.BlockedBy,
				Path:      path,
				CreatedAt: fm.CreatedAt,
			},
			Body:       extractBody(data),
			ClaimedAt:  fm.ClaimedAt,
			ResolvedAt: fm.ResolvedAt,
		}
		return nil
	})
	return detail, err
}

// AddComment appends a "- <body>" line at the end of the file, under the
// "## Comments" section (the last section in the G4 body skeleton).
func (l *LocalBackend) AddComment(mapSlug, ticketID, body string) error {
	return l.withRoot(func(root *os.Root) error {
		path, fm, err := readTicket(root, mapSlug, ticketID)
		if err != nil {
			return err
		}
		data, err := root.ReadFile(path)
		if err != nil {
			return errors.Wrapf(err, "reading ticket file")
		}
		full := string(data)
		if !strings.Contains(full, "## Comments") {
			return errors.Wrapf(ErrHeadingMissing, "ticket #%s has no '## Comments' section", fm.ID)
		}
		full = strings.TrimRight(full, "\n") + "\n\n- " + strings.TrimSpace(body) + "\n"
		return root.WriteFile(path, []byte(full), 0644)
	})
}

func (l *LocalBackend) SetStatus(mapSlug, ticketID, status string) error {
	return l.withRoot(func(root *os.Root) error {
		return SetStatus(root, mapSlug, ticketID, status, time.Now().UTC())
	})
}

func (l *LocalBackend) SetTriage(mapSlug, ticketID, triage string) error {
	return l.withRoot(func(root *os.Root) error {
		return SetTriage(root, mapSlug, ticketID, triage)
	})
}

func (l *LocalBackend) SetBlocking(mapSlug, ticketID string, blockedBy []string) error {
	return l.withRoot(func(root *os.Root) error {
		return SetBlocking(root, mapSlug, ticketID, blockedBy)
	})
}

func (l *LocalBackend) Frontier(mapSlug string) ([]TicketSummary, error) {
	var frontier []TicketSummary
	err := l.withRoot(func(root *os.Root) error {
		var err error
		frontier, err = Frontier(root, mapSlug)
		return err
	})
	return frontier, err
}

// CloseVerify is meaningless locally — there are no MRs/PRs in markdown files.
func (l *LocalBackend) CloseVerify(opts CloseVerifyOpts) (CloseVerifyReport, error) {
	return CloseVerifyReport{}, errors.Wrap(ErrInvalidInput,
		"close-verify requires a remote backend (--backend github|gitlab)")
}
