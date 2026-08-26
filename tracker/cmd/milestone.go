package cmd

import (
	"time"

	"github.com/peachest/pi-packages/tracker/tracker"
	"github.com/spf13/cobra"
)

func newMilestoneCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "milestone",
		Short: "Manage milestones",
	}
	cmd.AddCommand(newMilestoneStateCmd())
	cmd.AddCommand(newMilestoneProgressCmd())
	cmd.AddCommand(newMilestoneListCmd())
	return cmd
}

func newMilestoneStateCmd() *cobra.Command {
	var (
		slug     string
		newState string
	)

	cmd := &cobra.Command{
		Use:   "state",
		Short: "Set milestone state (active|closed)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			scratchDir, err := resolveScratch()
			if err != nil {
				return err
			}

			if err := tracker.SetMilestoneState(fs, scratchDir, slug, newState, time.Now().UTC()); err != nil {
				return err
			}

			mfm, err := tracker.ReadMilestone(fs, scratchDir, slug)
			if err != nil {
				return err
			}

			return outputJSON(cmd, map[string]any{
				"slug":       slug,
				"title":      mfm.Title,
				"state":      mfm.State,
				"closed_at":  mfm.ClosedAt,
			})
		},
	}

	cmd.Flags().StringVar(&slug, "slug", "", "milestone slug")
	cmd.Flags().StringVar(&newState, "set", "", "new state (active|closed)")
	cmd.MarkFlagRequired("slug")
	cmd.MarkFlagRequired("set")

	return cmd
}

func newMilestoneProgressCmd() *cobra.Command {
	var slug string

	cmd := &cobra.Command{
		Use:   "progress",
		Short: "Show milestone progress (aggregate of referencing maps)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			scratchDir, err := resolveScratch()
			if err != nil {
				return err
			}

			result, err := tracker.MilestoneProgress(fs, scratchDir, slug)
			if err != nil {
				return err
			}

			return outputJSON(cmd, result)
		},
	}

	cmd.Flags().StringVar(&slug, "slug", "", "milestone slug")
	cmd.MarkFlagRequired("slug")

	return cmd
}

func newMilestoneListCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List all milestones",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			scratchDir, err := resolveScratch()
			if err != nil {
				return err
			}

			milestones, err := tracker.ListMilestones(fs, scratchDir)
			if err != nil {
				return err
			}

			return outputJSON(cmd, milestones)
		},
	}

	return cmd
}