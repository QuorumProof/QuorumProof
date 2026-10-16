# Network Policy for Pod Security

**Issue #1655** — Network policies aren't enforced. This document describes the
Kubernetes NetworkPolicy architecture for QuorumProof: what is allowed, what is
blocked, how to test, and how to maintain policies as the cluster evolves.

## Overview

Without NetworkPolicies, any compromised pod in the `quorumproof` namespace can
reach any other pod — database, monitoring, or application — on any port. This
enables trivial lateral movement by an attacker who has exploited a single
service.

The policies in `k8s/network-policy/` implement a **default-deny** posture:
all ingress and egress traffic is blocked unless explicitly permitted by an
allow rule.

---

## Policy Files

| File | Purpose |
|------|---------|
| `k8s/network-policy/default-deny.yaml` | Deny all ingress + egress for every pod in the namespace |
| `k8s/network-policy/api-server-policy.yaml` | Allow rules for API server ingress and egress |
| `k8s/network-policy/monitoring-policy.yaml` | Allow rules for Prometheus and Grafana |
| `k8s/network-policy/kustomization.yaml` | Kustomize root for applying all policies at once |

---

## Traffic Matrix

### API Server (`app: quorumproof-api-server`)

| Direction | Source/Dest | Port | Allowed | Reason |
|-----------|------------|------|---------|--------|
| Ingress | `ingress-nginx` namespace | 3001 | ✅ | Production HTTP traffic |
| Ingress | Prometheus (monitoring ns) | 3001 | ✅ | Metrics scraping |
| Ingress | Node CIDR (10.0.0.0/8) | 3001 | ✅ | Kubelet health probes |
| Ingress | Any other source | any | ❌ | Default deny |
| Egress | kube-dns | 53/UDP+TCP | ✅ | DNS resolution |
| Egress | `quorumproof-postgres` pod | 5432 | ✅ | Database |
| Egress | `quorumproof-redis` pod | 6379 | ✅ | Cache |
| Egress | External (0.0.0.0/0 excl. RFC-1918) | 443 | ✅ | Soroban RPC, webhooks |
| Egress | Prometheus (monitoring ns) | 9090 | ✅ | Rule push / federation |
| Egress | Any RFC-1918 address | any | ❌ | Block lateral movement |
| Egress | Other pods in namespace | any | ❌ | Default deny |

### Prometheus (`app: prometheus` in `monitoring` namespace)

| Direction | Source/Dest | Port | Allowed |
|-----------|------------|------|---------|
| Ingress | Grafana | 9090 | ✅ |
| Ingress | quorumproof namespace | 9090 | ✅ |
| Egress | API server (quorumproof ns) | 3001 | ✅ |
| Egress | Alertmanager | 9093 | ✅ |
| Egress | kube-dns | 53 | ✅ |

---

## Applying the Policies

```bash
# Apply all policies at once (recommended)
kubectl apply -k k8s/network-policy/

# Or apply individually (apply allow rules BEFORE default-deny to avoid downtime)
kubectl apply -f k8s/network-policy/api-server-policy.yaml
kubectl apply -f k8s/network-policy/monitoring-policy.yaml
kubectl apply -f k8s/network-policy/default-deny.yaml
```

### Verify policies are applied

```bash
kubectl get networkpolicy -n quorumproof
kubectl get networkpolicy -n monitoring
kubectl describe networkpolicy default-deny-all -n quorumproof
```

---

## Testing

Run the automated connectivity tests:

```bash
# Full test (requires cluster access and a running deployment)
./scripts/test_network_policies.sh --namespace quorumproof

# Dry-run (print test plan without executing)
./scripts/test_network_policies.sh --dry-run
```

### Manual spot-check

```bash
# 1. Verify an untrusted pod CANNOT reach the api-server
kubectl run netpol-test \
  --image=ghcr.io/nicolaka/netshoot:latest \
  --namespace=quorumproof \
  --restart=Never \
  --rm \
  -it \
  -- curl -sf --max-time 5 http://quorumproof-api-server:3001/health
# Expected: connection timeout or refused (policy blocks it)

# 2. Verify api-server CAN reach Stellar RPC
kubectl exec -n quorumproof \
  $(kubectl get pod -n quorumproof -l app=quorumproof-api-server -o name | head -1) \
  -- curl -sf --max-time 5 https://soroban-testnet.stellar.org -o /dev/null && \
  echo "ALLOWED (expected)" || echo "BLOCKED (unexpected)"

# 3. Verify Prometheus CAN scrape the api-server
kubectl exec -n monitoring \
  $(kubectl get pod -n monitoring -l app=prometheus -o name | head -1) \
  -- curl -sf --max-time 5 http://quorumproof-api-server.quorumproof.svc:3001/metrics/events
```

---

## CNI Requirements

NetworkPolicies require a CNI plugin that enforces them. The following are
tested:

| CNI | Status |
|-----|--------|
| **Calico** | ✅ Recommended — supports GlobalNetworkPolicy extensions |
| **Cilium** | ✅ Supported — additional Layer 7 policies available |
| **AWS VPC CNI** + Calico | ✅ AWS EKS supported configuration |
| Flannel | ❌ Does NOT enforce NetworkPolicies |
| Weave Net | ⚠️ Partial support (no egress enforcement in older versions) |

Check your cluster's CNI:

```bash
kubectl get pods -n kube-system | grep -E "calico|cilium|flannel|weave"
```

---

## Policy Maintenance

### Adding a new service

1. Create a new allow policy file: `k8s/network-policy/<service>-policy.yaml`
2. Follow the pattern in `api-server-policy.yaml`:
   - One resource per direction (separate ingress + egress)
   - Use `podSelector` + `namespaceSelector` for internal, `ipBlock` for external
3. Add to `kustomization.yaml`
4. Apply and run `scripts/test_network_policies.sh`
5. Document the traffic matrix in this file

### Updating CIDR blocks

The external egress rule uses `0.0.0.0/0` with RFC-1918 exclusions. For
production hardening, replace this with specific CIDR blocks for:

- Stellar RPC endpoints (obtain from your cloud provider's route table)
- Slack API: `54.183.0.0/16`, `52.44.0.0/15` (subject to change — prefer FQDN via egress gateway)
- PagerDuty: `18.185.0.0/16` (EU) / `35.166.0.0/16` (US)

Alternatively, use a CNI egress gateway (Calico Enterprise, Cilium Enterprise)
to enforce FQDN-based egress rules without maintaining IP lists.

### Blue-green deployments

The `api-server-policy.yaml` uses `app: quorumproof-api-server` as the pod
selector, which matches both `slot: blue` and `slot: green` pods. No policy
update is required during blue-green slot switches. If you need slot-specific
policies, add a `slot` label to the `podSelector`.

---

## Troubleshooting

### Pod cannot reach a service it should reach

```bash
# Check which policies apply to the pod
kubectl describe pod <pod-name> -n quorumproof | grep -A5 "Labels:"
kubectl get networkpolicy -n quorumproof -o yaml | \
  grep -A10 "podSelector:"

# Use netshoot for live debugging
kubectl run debug --image=ghcr.io/nicolaka/netshoot --rm -it \
  --namespace quorumproof -- tcpdump -i eth0 port 5432
```

### Policy change not taking effect

NetworkPolicy changes take effect immediately (no pod restart required). If
changes don't appear to take effect, check:

1. `kubectl get networkpolicy -n quorumproof` — verify the policy exists
2. Check CNI plugin logs: `kubectl logs -n kube-system -l app=calico-node`
3. Ensure the pod labels match the `podSelector` exactly

---

## See Also

- [`k8s/network-policy/`](../k8s/network-policy/) — policy manifests
- [`scripts/test_network_policies.sh`](../scripts/test_network_policies.sh) — automated tests
- [`docs/threat-model.md`](threat-model.md) — lateral movement threat analysis
- [`docs/security-best-practices.md`](security-best-practices.md) — broader security guide
