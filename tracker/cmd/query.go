package cmd

import (
	"github.com/peachest/pi-packages/tracker/tracker"
	"github.com/spf13/cobra"
)

func newQueryCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "query",
		Short: "Query derived views",
	}
	cmd.AddCommand(newQueryFrontierCmd())
	return cmd
}

func newQueryFrontierCmd() *cobra.Command {
	var mapSlug string

	cmd := &cobra.Command{
		Use:   "frontier",
		Short: "List frontier tickets (open, unblocked, untriaged or ready-for-agent)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			root, err := openScratchRoot()
			defer root.Close()
			if err != nil {
				return err
			}

			frontier, err := tracker.Frontier(root, mapSlug)
			if err != nil {
				return err
			}

			return outputJSON(cmd, frontier)
		},
	}

	cmd.Flags().StringVar(&mapSlug, "map", "", "map slug")
	cmd.MarkFlagRequired("map")

	return cmd
}
