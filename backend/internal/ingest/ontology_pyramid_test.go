package ingest

import "testing"

func TestValidateOntologyPyramid_AtomRequiresMessageRefs(t *testing.T) {
	err := validateOntologyPyramid(
		[]ontologyNodeIn{{ID: "a", EntityType: "PainPoint", Name: "x", Properties: map[string]any{}}},
		nil,
	)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestValidateOntologyPyramid_ScenarioNeedsLinks(t *testing.T) {
	msg := "0192d4ef-0000-7000-8000-eeeeeeeeeeee"
	nodes := []ontologyNodeIn{
		{ID: "c", EntityType: "Customer", Name: "C"},
		{ID: "a", EntityType: "PainPoint", Name: "p", Properties: map[string]any{"source_message_ids": []any{msg}}},
		{ID: "s", EntityType: "Scenario", Name: "S"},
	}
	if err := validateOntologyPyramid(nodes, nil); err == nil {
		t.Fatal("expected missing CONTAINS_ATOM")
	}
	edges := []ontologyEdgeIn{
		{ID: "e1", SourceNodeID: "s", TargetNodeID: "a", RelationType: "CONTAINS_ATOM"},
	}
	if err := validateOntologyPyramid(nodes, edges); err == nil {
		t.Fatal("expected missing HAS_SCENARIO")
	}
	edges = append(edges, ontologyEdgeIn{ID: "e2", SourceNodeID: "c", TargetNodeID: "s", RelationType: "HAS_SCENARIO"})
	if err := validateOntologyPyramid(nodes, edges); err != nil {
		t.Fatal(err)
	}
}

func TestValidateOntologyPyramid_AtomsWithoutScenarioOK(t *testing.T) {
	err := validateOntologyPyramid(
		[]ontologyNodeIn{
			{ID: "c", EntityType: "Customer", Name: "C"},
			{ID: "a", EntityType: "Preference", Name: "kakao", Properties: map[string]any{"source_message_ids": []any{"m1"}}},
		},
		[]ontologyEdgeIn{{ID: "e", SourceNodeID: "c", TargetNodeID: "a", RelationType: "PREFERS"}},
	)
	if err != nil {
		t.Fatal(err)
	}
}
