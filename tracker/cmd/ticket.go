package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/peachest/pi-packages/tracker/tracker"
	"github.com/spf13/cobra"
)

// Execute runs the root command.
func Execute(ctx context.Context) error {
	return NewRootCmd().ExecuteContext(ctx)
}

// NewRootCmd creates the root command tree.
func NewRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "tracker",
		Short:         "Local markdown issue tracker CLI",
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	root.AddCommand(newTicketCmd())
	root.AddCommand(newQueryCmd())
	root.AddCommand(newMapCmd())
	root.AddCommand(newMilestoneCmd())

	return root
}

func newTicketCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "ticket",
		Short: "Manage tickets",
	}
	cmd.AddCommand(newTicketCreateCmd())
	cmd.AddCommand(newTicketListCmd())
	cmd.AddCommand(newTicketReviewCmd())
	cmd.AddCommand(newTicketStatusCmd())
	cmd.AddCommand(newTicketTriageCmd())
	cmd.AddCommand(newTicketBlockingCmd())
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
			scratchDir, err := resolveScratch()
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

			ticket, err := tracker.CreateTicket(fs, scratchDir, opts, time.Now().UTC())
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
			scratchDir, err := resolveScratch()
			if err != nil {
				return err
			}

			filter := tracker.ListFilter{
				Status:    status,
				Type:      typeVal,
				TriageNull: triageNull,
			}
			if !triageNull && triage != "" {
				filter.Triage = triage
			}

			tickets, err := tracker.ListTickets(fs, scratchDir, mapSlug, filter)
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
			scratchDir, err := resolveScratch()
			if err != nil {
				return err
			}

			if err := tracker.ReviewTicket(fs, scratchDir, mapSlug, ticketID, time.Now().UTC()); err != nil {
				return err
			}

			// Read back to get the timestamp
			_, fm, err := tracker.ReadTicketForDisplay(fs, scratchDir, mapSlug, ticketID)
			if err != nil {
				return err
			}

			return outputJSON(cmd, map[string]any{
				"id":         fm.ID,
				"map":        mapSlug,
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
			scratchDir, err := resolveScratch()
			if err != nil {
				return err
			}

			if err := tracker.SetStatus(fs, scratchDir, mapSlug, ticketID, status, time.Now().UTC()); err != nil {
				return err
			}

			_, fm, err := tracker.ReadTicketForDisplay(fs, scratchDir, mapSlug, ticketID)
			if err != nil {
				return err
			}

			return outputJSON(cmd, map[string]any{
				"id":          fm.ID,
				"map":         mapSlug,
				"status":      fm.Status,
				"claimed_at":  fm.ClaimedAt,
				"resolved_at": fm.ResolvedAt,
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
			scratchDir, err := resolveScratch()
			if err != nil {
				return err
			}

			if err := tracker.SetTriage(fs, scratchDir, mapSlug, ticketID, triage); err != nil {
				return err
			}

			_, fm, err := tracker.ReadTicketForDisplay(fs, scratchDir, mapSlug, ticketID)
			if err != nil {
				return err
			}

			return outputJSON(cmd, map[string]any{
				"id":     fm.ID,
				"map":    mapSlug,
				"triage": fm.Triage,
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
			scratchDir, err := resolveScratch()
			if err != nil {
				return err
			}

			var ids []string
			if blockedBy != "" {
				ids = strings.Split(blockedBy, ",")
			}

			if err := tracker.SetBlocking(fs, scratchDir, mapSlug, ticketID, ids); err != nil {
				return err
			}

			_, fm, err := tracker.ReadTicketForDisplay(fs, scratchDir, mapSlug, ticketID)
			if err != nil {
				return err
			}

			return outputJSON(cmd, map[string]any{
				"id":         fm.ID,
				"map":        mapSlug,
				"blocked_by": fm.BlockedBy,
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

// outputJSON writes the value as JSON to the command's stdout.
func outputJSON(cmd *cobra.Command, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling JSON: %w", err)
	}
	_, err = fmt.Fprintln(cmd.OutOrStdout(), string(data))
	return err
}

