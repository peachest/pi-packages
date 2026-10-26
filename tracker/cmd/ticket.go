package cmd

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/peachest/pi-packages/tracker/tracker"
	"github.com/pkg/errors"
	"github.com/spf13/cobra"
)

func newTicketCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "ticket",
		Short: "Manage tickets",
	}
	cmd.AddCommand(newTicketCreateCmd())
	cmd.AddCommand(newTicketListCmd())
	cmd.AddCommand(newTicketViewCmd())
	cmd.AddCommand(newTicketCommentCmd())
	cmd.AddCommand(newTicketReviewCmd())
	cmd.AddCommand(newTicketStatusCmd())
	cmd.AddCommand(newTicketTriageCmd())
	cmd.AddCommand(newTicketBlockingCmd())
	cmd.AddCommand(newTicketCloseVerifyCmd())
	return cmd
}

func newTicketCreateCmd() *cobra.Command {
	var (
		mapSlug   string
		title     string
		typeVal   string
		blockedBy string
		triage    string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new ticket",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			backend, err := resolveBackend(cmd)
			if err != nil {
				return err
			}

			opts := tracker.TicketOpts{
				MapSlug: mapSlug,
				Title:   title,
				Type:    typeVal,
			}

			if blockedBy != "" {
				opts.BlockedBy = strings.Split(blockedBy, ",")
			}

			if cmd.Flags().Changed("triage") {
				t := triage
				opts.Triage = &t
			}

			ticket, err := backend.CreateTicket(opts)
			if err != nil {
				return err
			}

			return outputJSON(cmd, ticket)
		},
	}

	cmd.Flags().StringVar(&mapSlug, "map", "", "map slug")
	cmd.Flags().StringVar(&title, "title", "", "ticket title")
	cmd.Flags().StringVar(&typeVal, "type", "", "ticket type (research|prototype|grilling|task)")
	cmd.Flags().StringVar(&blockedBy, "blocked-by", "", "comma-separated blocker IDs")
	cmd.Flags().StringVar(&triage, "triage", "", "triage role (needs-triage|needs-info|ready-for-agent|ready-for-human|wontfix)")

	cmd.MarkFlagRequired("map")
	cmd.MarkFlagRequired("title")
	cmd.MarkFlagRequired("type")

	return cmd
}

func newTicketListCmd() *cobra.Command {
	var (
		mapSlug    string
		status     string
		typeVal    string
		triage     string
		triageNull bool
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List tickets in a map",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			backend, err := resolveBackend(cmd)
			if err != nil {
				return err
			}

			filter := tracker.ListFilter{
				Status:     status,
				Type:       typeVal,
				TriageNull: triageNull,
			}
			if !triageNull && triage != "" {
				filter.Triage = triage
			}

			tickets, err := backend.ListTickets(mapSlug, filter)
			if err != nil {
				return err
			}

			return outputJSON(cmd, tickets)
		},
	}

	cmd.Flags().StringVar(&mapSlug, "map", "", "map slug")
	cmd.Flags().StringVar(&status, "status", "", "filter by status (open|claimed|resolved)")
	cmd.Flags().StringVar(&typeVal, "type", "", "filter by type")
	cmd.Flags().StringVar(&triage, "triage", "", "filter by triage role")
	cmd.Flags().BoolVar(&triageNull, "triage-null", false, "filter tickets with triage=null")

	cmd.MarkFlagRequired("map")

	return cmd
}

func newTicketViewCmd() *cobra.Command {
	var (
		mapSlug  string
		ticketID string
	)

	cmd := &cobra.Command{
		Use:   "view",
		Short: "View a ticket (body + comments)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			backend, err := resolveBackend(cmd)
			if err != nil {
				return err
			}

			detail, err := backend.GetTicket(mapSlug, ticketID)
			if err != nil {
				return err
			}

			return outputJSON(cmd, detail)
		},
	}

	cmd.Flags().StringVar(&mapSlug, "map", "", "map slug")
	cmd.Flags().StringVar(&ticketID, "id", "", "ticket ID")
	cmd.MarkFlagRequired("map")
	cmd.MarkFlagRequired("id")

	return cmd
}

func newTicketCommentCmd() *cobra.Command {
	var (
		mapSlug  string
		ticketID string
		body     string
	)

	cmd := &cobra.Command{
		Use:   "comment",
		Short: "Add a comment to a ticket",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			backend, err := resolveBackend(cmd)
			if err != nil {
				return err
			}

			if err := backend.AddComment(mapSlug, ticketID, body); err != nil {
				return err
			}

			return outputJSON(cmd, map[string]any{
				"id":      ticketID,
				"map":     mapSlug,
				"comment": body,
			})
		},
	}

	cmd.Flags().StringVar(&mapSlug, "map", "", "map slug")
	cmd.Flags().StringVar(&ticketID, "id", "", "ticket ID")
	cmd.Flags().StringVar(&body, "body", "", "comment text")
	cmd.MarkFlagRequired("map")
	cmd.MarkFlagRequired("id")
	cmd.MarkFlagRequired("body")

	return cmd
}

func newTicketReviewCmd() *cobra.Command {
	var (
		mapSlug  string
		ticketID string
	)

	cmd := &cobra.Command{
		Use:   "review",
		Short: "Mark a ticket as reviewed (review-spec passed)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// review is the local reviewed_at gate before claiming; remote
			// hosting platforms have no equivalent field.
			if err := requireLocal(cmd); err != nil {
				return err
			}

			root, err := openScratchRoot()
			defer root.Close()
			if err != nil {
				return err
			}

			if err := tracker.ReviewTicket(root, mapSlug, ticketID, nowUTC()); err != nil {
				return err
			}

			// Read back to get the timestamp
			_, fm, err := tracker.ReadTicketForDisplay(root, mapSlug, ticketID)
			if err != nil {
				return err
			}

			return outputJSON(cmd, map[string]any{
				"id":          fm.ID,
				"map":         mapSlug,
				"reviewed_at": fm.ReviewedAt,
			})
		},
	}

	cmd.Flags().StringVar(&mapSlug, "map", "", "map slug")
	cmd.Flags().StringVar(&ticketID, "id", "", "ticket ID")
	cmd.MarkFlagRequired("map")
	cmd.MarkFlagRequired("id")

	return cmd
}

func newTicketStatusCmd() *cobra.Command {
	var (
		mapSlug  string
		ticketID string
		status   string
	)

	cmd := &cobra.Command{
		Use:   "status",
		Short: "Set ticket status (open|claimed|resolved)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			backend, err := resolveBackend(cmd)
			if err != nil {
				return err
			}

			if err := backend.SetStatus(mapSlug, ticketID, status); err != nil {
				return err
			}

			detail, err := backend.GetTicket(mapSlug, ticketID)
			if err != nil {
				return err
			}

			return outputJSON(cmd, map[string]any{
				"id":     detail.ID,
				"map":    mapSlug,
				"status": detail.Status,
			})
		},
	}

	cmd.Flags().StringVar(&mapSlug, "map", "", "map slug")
	cmd.Flags().StringVar(&ticketID, "id", "", "ticket ID")
	cmd.Flags().StringVar(&status, "set", "", "new status (open|claimed|resolved)")
	cmd.MarkFlagRequired("map")
	cmd.MarkFlagRequired("id")
	cmd.MarkFlagRequired("set")

	return cmd
}

func newTicketTriageCmd() *cobra.Command {
	var (
		mapSlug  string
		ticketID string
		triage   string
	)

	cmd := &cobra.Command{
		Use:   "triage",
		Short: "Set ticket triage role",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			backend, err := resolveBackend(cmd)
			if err != nil {
				return err
			}

			if err := backend.SetTriage(mapSlug, ticketID, triage); err != nil {
				return err
			}

			detail, err := backend.GetTicket(mapSlug, ticketID)
			if err != nil {
				return err
			}

			return outputJSON(cmd, map[string]any{
				"id":     detail.ID,
				"map":    mapSlug,
				"triage": detail.Triage,
			})
		},
	}

	cmd.Flags().StringVar(&mapSlug, "map", "", "map slug")
	cmd.Flags().StringVar(&ticketID, "id", "", "ticket ID")
	cmd.Flags().StringVar(&triage, "set", "", "triage role (needs-triage|needs-info|ready-for-agent|ready-for-human|wontfix)")
	cmd.MarkFlagRequired("map")
	cmd.MarkFlagRequired("id")
	cmd.MarkFlagRequired("set")

	return cmd
}

func newTicketBlockingCmd() *cobra.Command {
	var (
		mapSlug   string
		ticketID  string
		blockedBy string
	)

	cmd := &cobra.Command{
		Use:   "blocking",
		Short: "Set ticket blocked_by (replace semantics)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			backend, err := resolveBackend(cmd)
			if err != nil {
				return err
			}

			var ids []string
			if blockedBy != "" {
				ids = strings.Split(blockedBy, ",")
			}

			if err := backend.SetBlocking(mapSlug, ticketID, ids); err != nil {
				return err
			}

			detail, err := backend.GetTicket(mapSlug, ticketID)
			if err != nil {
				return err
			}

			return outputJSON(cmd, map[string]any{
				"id":         detail.ID,
				"map":        mapSlug,
				"blocked_by": detail.BlockedBy,
			})
		},
	}

	cmd.Flags().StringVar(&mapSlug, "map", "", "map slug")
	cmd.Flags().StringVar(&ticketID, "id", "", "ticket ID")
	cmd.Flags().StringVar(&blockedBy, "by", "", "comma-separated blocker IDs (empty to clear)")
	cmd.MarkFlagRequired("map")
	cmd.MarkFlagRequired("id")

	return cmd
}

// newTicketCloseVerifyCmd implements the close-verify increment: given an
// MR/PR number or merge SHA, re-scan every closing pattern (description +
// all commit messages), verify each referenced ticket's state, and report —
// or with --apply, comment + close — the ones the platform failed to close
// (non-default-branch merges, multi-ref merge commits, squash-dropped refs).
func newTicketCloseVerifyCmd() *cobra.Command {
	var (
		ref   string
		apply bool
	)

	cmd := &cobra.Command{
		Use:   "close-verify",
		Short: "Verify closing patterns from an MR/PR or merge SHA and (with --apply) close missed tickets",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			backend, err := resolveBackend(cmd)
			if err != nil {
				return err
			}

			report, err := backend.CloseVerify(tracker.CloseVerifyOpts{Ref: ref, Apply: apply})
			if err != nil {
				return err
			}

			return outputJSON(cmd, report)
		},
	}

	cmd.Flags().StringVar(&ref, "ref", "", "PR/MR number or merge/commit SHA")
	cmd.Flags().BoolVar(&apply, "apply", false, "comment + close the tickets the platform missed (default: dry-run)")
	cmd.MarkFlagRequired("ref")

	return cmd
}

// outputJSON writes the value as JSON to the command's stdout.
func outputJSON(cmd *cobra.Command, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return errors.Wrapf(err, "marshaling JSON")
	}
	_, err = fmt.Fprintln(cmd.OutOrStdout(), string(data))
	return err
}
