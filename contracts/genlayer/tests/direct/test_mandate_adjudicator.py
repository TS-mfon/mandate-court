import json
import hashlib
import pytest


CASES = [
    ("research-perfect", "RESEARCH_DATA_V1", "FULFILLED", ["PASS", "PASS"]),
    ("research-partial", "RESEARCH_DATA_V1", "PARTIALLY_FULFILLED", ["PASS", "PARTIAL"]),
    ("research-conflict", "RESEARCH_DATA_V1", "BREACHED", ["PASS", "FAIL"]),
    ("research-injection", "RESEARCH_DATA_V1", "UNDETERMINED", ["UNVERIFIABLE", "UNVERIFIABLE"]),
    ("website-perfect", "SOFTWARE_WEB_V1", "FULFILLED", ["PASS", "PASS"]),
    ("api-broken", "SOFTWARE_WEB_V1", "BREACHED", ["PASS", "FAIL"]),
    ("software-misleading", "SOFTWARE_WEB_V1", "PARTIALLY_FULFILLED", ["PASS", "PARTIAL"]),
    ("images-perfect", "CREATIVE_VISUAL_V1", "FULFILLED", ["PASS", "PASS"]),
    ("images-missing-brand", "CREATIVE_VISUAL_V1", "BREACHED", ["PASS", "FAIL"]),
    ("creative-provenance", "CREATIVE_VISUAL_V1", "UNDETERMINED", ["PASS", "UNVERIFIABLE"]),
]


def address(value):
    return value


def mandate(case_id):
    return {
        "mandateId": case_id,
        "objective": "Verify the submitted work against two atomic criteria.",
        "acceptanceCriteria": [
            {"id": "C1", "weightBps": 6000, "critical": False, "requirement": "Primary output"},
            {"id": "C2", "weightBps": 4000, "critical": True, "requirement": "Evidence quality"},
        ],
    }


def manifest(case_id):
    evidence_body = b"Public fixture evidence"
    return {
        "protocol": "mdp/1.0",
        "mandateId": case_id,
        "evidence": [
            {
                "id": "E1",
                "url": f"https://evidence.example/{case_id}",
                "sha256": "0x" + hashlib.sha256(evidence_body).hexdigest(),
            }
        ],
    }


def payload(case_id):
    locked_mandate = mandate(case_id)
    delivery_bundle = {"manifest": manifest(case_id), "snapshots": []}
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"))
    digest = lambda value: "0x" + hashlib.sha256(canonical(value).encode()).hexdigest()
    return canonical(locked_mandate), canonical(delivery_bundle), digest(locked_mandate), digest(delivery_bundle)


def judgment(verdict, results):
    weights = [6000, 4000]
    settlement = sum(weight if result == "PASS" else weight // 2 if result == "PARTIAL" else 0 for weight, result in zip(weights, results))
    material = ["Critical evidence requirement failed"] if verdict == "BREACHED" else []
    return {
        "verdict": verdict,
        "confidenceBps": 9000 if verdict != "UNDETERMINED" else 4500,
        "criteria": [
            {
                "id": f"C{index + 1}",
                "result": result,
                "severity": "CRITICAL" if index == 1 else "HIGH",
                "evidenceRefs": ["E1"] if result in ("PASS", "PARTIAL") else [],
                "reasonCode": "FIXTURE_RESULT",
                "reason": "The fixture evidence supports this finding.",
            }
            for index, result in enumerate(results)
        ],
        "admissibility": [{"id": "E1", "status": "ADMISSIBLE", "reason": "Public fixture"}],
        "contradictions": [],
        "materialBreaches": material,
        "missingEvidence": ["Independent provenance"] if verdict == "UNDETERMINED" else [],
        "settlementBps": settlement,
        "appealGrounds": [],
        "summary": "Fixture judgment completed.",
    }


@pytest.mark.parametrize("case_id,policy,verdict,results", CASES)
def test_ten_work_categories_finalize(direct_vm, direct_deploy, direct_alice, case_id, policy, verdict, results):
    direct_vm.sender = direct_alice
    contract = direct_deploy("contracts/genlayer/mandate_adjudicator.py", address(direct_alice))
    direct_vm.mock_web(r"https://evidence\.example/.*", {"status": 200, "body": "Public fixture evidence"})
    direct_vm.mock_llm(r".*INDEPENDENT FORENSIC ADJUDICATOR.*", json.dumps(judgment(verdict, results)))
    result = contract.submit_case(case_id, *payload(case_id), policy)
    assert result["status"] == "FINALIZED"
    assert result["judgment"]["verdict"] == verdict
    assert result["judgment"]["settlementBps"] >= 0


def test_rejects_unsupported_policy(direct_vm, direct_deploy, direct_alice):
    direct_vm.sender = direct_alice
    contract = direct_deploy("contracts/genlayer/mandate_adjudicator.py", address(direct_alice))
    with direct_vm.expect_revert("Unsupported court policy"):
        contract.submit_case("bad-policy", *payload("bad-policy"), "UNKNOWN_V1")


def test_rejects_missing_criterion(direct_vm, direct_deploy, direct_alice):
    direct_vm.sender = direct_alice
    contract = direct_deploy("contracts/genlayer/mandate_adjudicator.py", address(direct_alice))
    direct_vm.mock_web(r"https://evidence\.example/.*", {"status": 200, "body": "Public fixture evidence"})
    malformed = judgment("PARTIALLY_FULFILLED", ["PASS", "FAIL"])
    malformed["criteria"] = malformed["criteria"][:1]
    direct_vm.mock_llm(r".*INDEPENDENT FORENSIC ADJUDICATOR.*", json.dumps(malformed))
    with direct_vm.expect_revert("Every mandate criterion"):
        contract.submit_case("missing-criterion", *payload("missing-criterion"), "GENERAL_V1")


def test_records_mutated_evidence_hash_mismatch(direct_vm, direct_deploy, direct_alice):
    direct_vm.sender = direct_alice
    contract = direct_deploy("contracts/genlayer/mandate_adjudicator.py", address(direct_alice))
    direct_vm.mock_web(r"https://evidence\.example/.*", {"status": 200, "body": "Changed after commitment"})
    direct_vm.mock_llm(
        r".*INDEPENDENT FORENSIC ADJUDICATOR.*",
        json.dumps(judgment("UNDETERMINED", ["UNVERIFIABLE", "UNVERIFIABLE"])),
    )
    result = contract.submit_case("mutable-evidence", *payload("mutable-evidence"), "GENERAL_V1")
    assert result["judgment"]["verdict"] == "UNDETERMINED"
