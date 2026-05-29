# Deployment Checklist

This document provides a comprehensive checklist for deploying QuorumProof to production environments. Follow this checklist sequentially to ensure a safe and successful deployment.

## Pre-Deployment Phase

### Code Review and Testing

- [ ] All code changes have been reviewed and approved
- [ ] All unit tests pass: `cargo test`
- [ ] All integration tests pass: `cargo test --test '*'`
- [ ] Code coverage is above 80%: `./scripts/coverage.sh`
- [ ] No security vulnerabilities detected: `cargo audit`
- [ ] Linting passes: `cargo clippy`
- [ ] No compiler warnings: `cargo build --release 2>&1 | grep -i warning`

### Security Verification

- [ ] Security audit completed and issues resolved
- [ ] Threat model reviewed and updated
- [ ] GDPR compliance verified
- [ ] Data retention policies documented
- [ ] Encryption keys are properly managed
- [ ] No hardcoded secrets in codebase
- [ ] Environment variables properly configured
- [ ] API authentication and authorization verified

### Documentation Review

- [ ] Deployment guide is up-to-date
- [ ] API documentation is current
- [ ] Architecture documentation is accurate
- [ ] Security best practices guide is reviewed
- [ ] Runbook for common operations is prepared
- [ ] Incident response procedures are documented
- [ ] Rollback procedures are documented

### Infrastructure Preparation

- [ ] Production environment is provisioned
- [ ] Database is initialized and backed up
- [ ] Monitoring and alerting systems are configured
- [ ] Logging infrastructure is in place
- [ ] Backup systems are tested
- [ ] Disaster recovery plan is in place
- [ ] Network security is configured (firewalls, WAF)
- [ ] SSL/TLS certificates are valid and installed

### Stellar Network Verification

- [ ] Stellar network is operational
- [ ] RPC endpoints are responding
- [ ] Network fees are within acceptable range
- [ ] Deployer account is funded
- [ ] Admin account is funded and separate from deployer
- [ ] Test transactions succeed on testnet

## Build Phase

### Build Verification

- [ ] Clean build succeeds: `./scripts/build.sh`
- [ ] All WASM artifacts are generated
- [ ] WASM file sizes are reasonable
- [ ] Build artifacts are reproducible
- [ ] No build warnings or errors
- [ ] Build logs are archived

### Artifact Verification

- [ ] `quorum_proof.wasm` exists and is valid
- [ ] `sbt_registry.wasm` exists and is valid
- [ ] `zk_verifier.wasm` exists and is valid
- [ ] WASM files are not corrupted
- [ ] WASM files are signed (if applicable)
- [ ] Checksums are calculated and stored

### Build Environment

- [ ] Rust version is 1.70+
- [ ] `wasm32-unknown-unknown` target is installed
- [ ] Stellar CLI is installed and updated
- [ ] All dependencies are locked
- [ ] Build environment is clean
- [ ] Build logs are captured

## Deployment Phase

### Pre-Deployment Checks

- [ ] Deployment window is scheduled
- [ ] Stakeholders are notified
- [ ] Rollback plan is reviewed
- [ ] Team is on standby
- [ ] Monitoring dashboards are open
- [ ] Communication channels are active
- [ ] Backup of current state is taken

### Contract Deployment

- [ ] Deploy `quorum_proof` contract
  - [ ] Deployment transaction succeeds
  - [ ] Contract address is recorded
  - [ ] Contract is verified on-chain
  - [ ] Contract initialization succeeds

- [ ] Deploy `sbt_registry` contract
  - [ ] Deployment transaction succeeds
  - [ ] Contract address is recorded
  - [ ] Contract is verified on-chain
  - [ ] Contract initialization succeeds

- [ ] Deploy `zk_verifier` contract
  - [ ] Deployment transaction succeeds
  - [ ] Contract address is recorded
  - [ ] Contract is verified on-chain
  - [ ] Contract initialization succeeds

### Configuration Deployment

- [ ] Environment variables are updated
- [ ] Contract addresses are configured
- [ ] API server is configured
- [ ] Frontend is configured
- [ ] Database migrations are applied
- [ ] Cache is cleared
- [ ] Configuration is verified

### Service Deployment

- [ ] API server is deployed
  - [ ] Service starts successfully
  - [ ] Health check passes
  - [ ] Logs show no errors
  - [ ] Metrics are being collected

- [ ] Frontend is deployed
  - [ ] Assets are served correctly
  - [ ] No 404 errors
  - [ ] Performance is acceptable
  - [ ] Browser console has no errors

- [ ] Background services are deployed
  - [ ] All services start successfully
  - [ ] Services are healthy
  - [ ] No error logs
  - [ ] Metrics are being collected

## Post-Deployment Validation

### Functional Testing

- [ ] API endpoints respond correctly
- [ ] Credential issuance works end-to-end
- [ ] Quorum slice creation works
- [ ] Attestation flow works
- [ ] Credential verification works
- [ ] Data export functionality works
- [ ] User authentication works
- [ ] Authorization checks work

### Integration Testing

- [ ] Contract interactions work correctly
- [ ] Database operations succeed
- [ ] Cache operations work
- [ ] External API calls succeed
- [ ] Webhook notifications work
- [ ] Email notifications work
- [ ] File uploads work

### Performance Testing

- [ ] API response times are acceptable
- [ ] Database queries are performant
- [ ] No memory leaks detected
- [ ] CPU usage is normal
- [ ] Network bandwidth is normal
- [ ] Load testing passes
- [ ] Stress testing passes

### Security Testing

- [ ] HTTPS is enforced
- [ ] Security headers are present
- [ ] CORS is properly configured
- [ ] Rate limiting works
- [ ] Authentication is enforced
- [ ] Authorization is enforced
- [ ] Input validation works
- [ ] SQL injection is prevented
- [ ] XSS protection is active

### Monitoring and Alerting

- [ ] All metrics are being collected
- [ ] Dashboards are displaying data
- [ ] Alerts are configured and working
- [ ] Log aggregation is working
- [ ] Error tracking is working
- [ ] Performance monitoring is active
- [ ] Security monitoring is active

### Data Integrity

- [ ] Database integrity checks pass
- [ ] No data corruption detected
- [ ] Backups are being created
- [ ] Backup restoration works
- [ ] Data consistency is verified
- [ ] Audit logs are being recorded

## Smoke Testing

### Critical Path Testing

- [ ] User can register
- [ ] User can create credentials
- [ ] User can create quorum slices
- [ ] Attestors can attest credentials
- [ ] Credentials can be verified
- [ ] SBTs can be minted
- [ ] Users can export data
- [ ] Admin functions work

### Edge Cases

- [ ] Expired credentials are handled
- [ ] Revoked credentials are handled
- [ ] Invalid inputs are rejected
- [ ] Concurrent operations work
- [ ] Large data sets are handled
- [ ] Network failures are handled
- [ ] Timeout scenarios work

## Rollback Preparation

### Rollback Plan

- [ ] Previous version is available
- [ ] Database rollback procedure is documented
- [ ] Contract rollback procedure is documented
- [ ] Configuration rollback procedure is documented
- [ ] Rollback testing has been completed
- [ ] Rollback time estimate is documented
- [ ] Rollback communication plan is ready

### Rollback Triggers

- [ ] Critical functionality is broken
- [ ] Data corruption is detected
- [ ] Security vulnerability is discovered
- [ ] Performance degradation is severe
- [ ] Availability is compromised
- [ ] Unrecoverable errors occur

### Rollback Execution

- [ ] Rollback decision is made
- [ ] Stakeholders are notified
- [ ] Rollback procedure is executed
- [ ] Services are restored
- [ ] Data integrity is verified
- [ ] Monitoring confirms success
- [ ] Post-incident review is scheduled

## Post-Deployment Monitoring

### First 24 Hours

- [ ] Monitor error rates
- [ ] Monitor performance metrics
- [ ] Monitor resource usage
- [ ] Monitor user activity
- [ ] Monitor security events
- [ ] Check for data anomalies
- [ ] Review logs for issues

### First Week

- [ ] Monitor system stability
- [ ] Collect performance baselines
- [ ] Verify all features work
- [ ] Monitor user feedback
- [ ] Check for edge cases
- [ ] Verify backup procedures
- [ ] Review security logs

### Ongoing

- [ ] Daily monitoring of key metrics
- [ ] Weekly review of logs
- [ ] Monthly security review
- [ ] Quarterly performance review
- [ ] Regular backup testing
- [ ] Regular disaster recovery drills

## Documentation and Communication

### Deployment Documentation

- [ ] Deployment date and time recorded
- [ ] Deployed version recorded
- [ ] Deployment notes documented
- [ ] Known issues documented
- [ ] Configuration changes documented
- [ ] Database changes documented
- [ ] API changes documented

### Communication

- [ ] Deployment announcement sent
- [ ] Status page updated
- [ ] Release notes published
- [ ] Changelog updated
- [ ] Team notified of completion
- [ ] Stakeholders notified
- [ ] Users notified (if applicable)

### Post-Deployment Review

- [ ] Deployment retrospective scheduled
- [ ] Issues identified and tracked
- [ ] Improvements documented
- [ ] Lessons learned captured
- [ ] Process improvements identified
- [ ] Team feedback collected

## Deployment Verification Script

Use this script to verify deployment status:

```bash
#!/bin/bash

set -e

echo "=== QuorumProof Deployment Verification ==="

# Check environment variables
echo "Checking environment variables..."
required_vars=(
  "STELLAR_NETWORK"
  "STELLAR_RPC_URL"
  "CONTRACT_QUORUM_PROOF"
  "CONTRACT_SBT_REGISTRY"
  "CONTRACT_ZK_VERIFIER"
)

for var in "${required_vars[@]}"; do
  if [ -z "${!var}" ]; then
    echo "ERROR: $var is not set"
    exit 1
  fi
  echo "✓ $var is set"
done

# Check contract deployment
echo ""
echo "Checking contract deployment..."

check_contract() {
  local contract_id=$1
  local contract_name=$2
  
  echo "Checking $contract_name ($contract_id)..."
  
  # Verify contract exists
  if stellar contract info --id "$contract_id" --network "$STELLAR_NETWORK" > /dev/null 2>&1; then
    echo "✓ $contract_name is deployed"
  else
    echo "ERROR: $contract_name is not deployed"
    exit 1
  fi
}

check_contract "$CONTRACT_QUORUM_PROOF" "quorum_proof"
check_contract "$CONTRACT_SBT_REGISTRY" "sbt_registry"
check_contract "$CONTRACT_ZK_VERIFIER" "zk_verifier"

# Check API server
echo ""
echo "Checking API server..."
if curl -s http://localhost:3000/health > /dev/null; then
  echo "✓ API server is responding"
else
  echo "WARNING: API server is not responding"
fi

# Check database
echo ""
echo "Checking database..."
if psql -c "SELECT 1" > /dev/null 2>&1; then
  echo "✓ Database is accessible"
else
  echo "WARNING: Database is not accessible"
fi

echo ""
echo "=== Deployment Verification Complete ==="
```

## Deployment Rollback Script

Use this script to rollback deployment:

```bash
#!/bin/bash

set -e

echo "=== QuorumProof Deployment Rollback ==="

# Confirm rollback
read -p "Are you sure you want to rollback? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
  echo "Rollback cancelled"
  exit 0
fi

# Restore previous version
echo "Restoring previous version..."
git checkout HEAD~1

# Rebuild
echo "Rebuilding contracts..."
./scripts/build.sh

# Restore database
echo "Restoring database..."
psql < backup/database.sql

# Restart services
echo "Restarting services..."
systemctl restart quorum-proof-api
systemctl restart quorum-proof-frontend

# Verify rollback
echo "Verifying rollback..."
./scripts/verify_deployment.sh

echo ""
echo "=== Rollback Complete ==="
```

## Deployment Troubleshooting

### Common Issues

**Issue**: Contract deployment fails with "insufficient balance"
- **Solution**: Ensure deployer account is funded with sufficient XLM

**Issue**: API server fails to start
- **Solution**: Check environment variables and database connectivity

**Issue**: Frontend shows blank page
- **Solution**: Check browser console for errors, verify API connectivity

**Issue**: Credentials cannot be issued
- **Solution**: Verify contract addresses are correct, check contract initialization

**Issue**: Performance is degraded
- **Solution**: Check database performance, verify network connectivity, review logs

### Getting Help

- Check logs: `journalctl -u quorum-proof-api -f`
- Review error codes: See [Error Code Reference](./error-codes.md)
- Contact support: support@quorumproof.io
- Check status page: https://status.quorumproof.io

## References

- [Production Deployment Guide](./deployment-guide.md)
- [Disaster Recovery Guide](./disaster-recovery.md)
- [Monitoring Guide](./monitoring-guide.md)
- [Security Best Practices](./security-best-practices.md)
- [Error Code Reference](./error-codes.md)
