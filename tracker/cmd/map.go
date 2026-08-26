package cmd

import (
	"time"

	"github.com/peachest/pi-packages/tracker/tracker"
	"github.com/spf13/cobra"
)

func newMapCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "map",
		Short: "Manage maps",
	}
	cmd.AddCommand(newMapStateCmd())
	cmd.AddCommand(newMapProgressCmd())
	cmd.AddCommand(newMapListCmd())
	return cmd
}

func newMapStateCmd() *cobra.Command {
	var (
		slug    string
		newState string
	)

	cmd := &cobra.Command{
		Use:   "state",
		Short: "Set map state (active|closed)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			scratchDir, err := resolveScratch()
			if err != nil {
				return err
			}

			if err := tracker.SetMapState(fs, scratchDir, slug, newState, time.Now().UTC()); err != nil {
				return err
			}

			mfm, err := tracker.ReadMap(fs, scratchDir, slug)
			if err != nil {
				return err
			}

			return outputJSON(cmd, map[string]any{
				"slug":    slug,
				"title":   mfm.Title,
				"state":   mfm.State,
				"closed_at": mfm.ClosedAt,
			})
		},
	}

	cmd.Flags().StringVar(&slug, "slug", "", "map slug")
	cmd.Flags().StringVar(&newState, "set", "", "new state (active|closed)")
	cmd.MarkFlagRequired("slug")
	cmd.MarkFlagRequired("set")

	return cmd
}

func newMapProgressCmd() *cobra.Command {
	var slug string

	cmd := &cobra.Command{
		Use:   "progress",
		Short: "Show map progress (ticket counts + frontier_size)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			scratchDir, err := resolveScratch()
			if err != nil {
				return err
			}

			progress, err := tracker.ComputeProgress(fs, scratchDir, slug)
			if err != nil {
				return err
			}

			frontierSize, err := tracker.ComputeFrontierSize(fs, scratchDir, slug)
			if err != nil {
				return err
			}

			mfm, err := tracker.ReadMap(fs, scratchDir, slug)
			if err != nil {
				return err
			}

			return outputJSON(cmd, map[string]any{
				"slug":          slug,
				"title":         mfm.Title,
				"state":         mfm.State,
				"milestone":     mfm.Milestone,
				"progress":      progress,
				"frontier_size": frontierSize,
			})
		},
	}

	cmd.Flags().StringVar(&slug, "slug", "", "map slug")
	cmd.MarkFlagRequired("slug")

	return cmd
}

func newMapListCmd() *cobra.Command {
	var milestone string

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List all maps with progress",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			scratchDir, err := resolveScratch()
			if err != nil {
				return err
			}

			maps, err := tracker.ListMaps(fs, scratchDir)
			if err != nil {
				return err
			}

			if milestone != "" {
				maps = tracker.FilterMapsByMilestone(maps, milestone)
			}

			return outputJSON(cmd, maps)
		},
	}

	cmd.Flags().StringVar(&milestone, "milestone", "", "filter by milestone slug")

	return cmd
}
