from types import SimpleNamespace

import pytest

from core.workflow.nodes.llm import DifyLLMNode
from graphon.model_runtime.entities.llm_entities import LLMStructuredOutput, LLMUsage
from graphon.nodes.llm.exc import LLMNodeError


def test_build_run_outputs_fails_when_structured_output_enabled_without_output() -> None:
    node = object.__new__(DifyLLMNode)
    node._node_data = SimpleNamespace(structured_output_enabled=True)
    node._file_outputs = []

    with pytest.raises(LLMNodeError, match="Structured output is enabled"):
        node._build_run_outputs(
            clean_text='{"route": "sales"}',
            usage=LLMUsage.empty_usage(),
            finish_reason="stop",
            reasoning_content="",
            structured_output=None,
        )


def test_build_run_outputs_keeps_structured_output_when_present() -> None:
    node = object.__new__(DifyLLMNode)
    node._node_data = SimpleNamespace(structured_output_enabled=True)
    node._file_outputs = []

    outputs = node._build_run_outputs(
        clean_text='{"route": "sales"}',
        usage=LLMUsage.empty_usage(),
        finish_reason="stop",
        reasoning_content="",
        structured_output=LLMStructuredOutput(structured_output={"route": "sales"}),
    )

    assert outputs["structured_output"] == {"route": "sales"}


def test_build_run_outputs_recovers_structured_output_from_text_when_missing() -> None:
    node = object.__new__(DifyLLMNode)
    node._node_data = SimpleNamespace(
        structured_output_enabled=True,
        structured_output={
            "schema": {
                "type": "object",
                "required": ["route"],
                "properties": {
                    "route": {
                        "type": "string",
                    },
                },
                "additionalProperties": False,
            },
        },
    )
    node._file_outputs = []

    outputs = node._build_run_outputs(
        clean_text='{"route":"sales"}',
        usage=LLMUsage.empty_usage(),
        finish_reason="stop",
        reasoning_content="",
        structured_output=None,
    )

    assert outputs["structured_output"] == {"route": "sales"}


def test_build_run_outputs_recovers_structured_output_even_when_switch_is_off() -> None:
    node = object.__new__(DifyLLMNode)
    node._node_data = SimpleNamespace(
        structured_output_enabled=False,
        structured_output={
            "schema": {
                "type": "object",
                "required": ["route"],
                "properties": {
                    "route": {
                        "type": "string",
                    },
                },
                "additionalProperties": False,
            },
        },
    )
    node._file_outputs = []

    outputs = node._build_run_outputs(
        clean_text='{"route":"sales"}',
        usage=LLMUsage.empty_usage(),
        finish_reason="stop",
        reasoning_content="",
        structured_output=None,
    )

    assert outputs["structured_output"] == {"route": "sales"}
