# This folder is the ONLY thing the appliance exposes

Everything under this directory is mounted into the appliance container at `/data/exposed`
and surfaced through the curated `workspace.*` capabilities (list / read, plus write only if
the manifest curates `workspace.write`). Nothing else of the host is reachable.

Drop the files you want an agent to see here. Delete this note if you like.
