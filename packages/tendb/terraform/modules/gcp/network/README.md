# tendb network module (gcp)

Thin VPC for the engine (+ optional console): one custom-mode network, one
subnet (default `10.60.0.0/24`), and — in `nat` mode only — a Cloud Router +
Cloud NAT for egress. In the default `public` mode there is no NAT; give the
engine an external IP instead (`assign_external_ip` output wires straight
into the engine module). Inbound stays firewall-gated either way.
