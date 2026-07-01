/**
 * Shared types mirroring the Soroban contract structs.
 * These map 1:1 to the on-chain data shapes returned by RPC calls.
 */
// ── zk_verifier ─────────────────────────────────────────────────────────────
export var ClaimType;
(function (ClaimType) {
    ClaimType["HasDegree"] = "HasDegree";
    ClaimType["HasLicense"] = "HasLicense";
    ClaimType["HasEmploymentHistory"] = "HasEmploymentHistory";
    ClaimType["HasCertification"] = "HasCertification";
    ClaimType["HasResearchPublication"] = "HasResearchPublication";
})(ClaimType || (ClaimType = {}));
export var DisputeStatus;
(function (DisputeStatus) {
    DisputeStatus[DisputeStatus["Open"] = 0] = "Open";
    DisputeStatus[DisputeStatus["Upheld"] = 1] = "Upheld";
    DisputeStatus[DisputeStatus["Dismissed"] = 2] = "Dismissed";
})(DisputeStatus || (DisputeStatus = {}));
