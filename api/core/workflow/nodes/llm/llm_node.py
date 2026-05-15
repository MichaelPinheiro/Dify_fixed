from __future__ import annotations

from typing import Any

from core.llm_generator.output_parser.errors import OutputParserError
from core.llm_generator.output_parser.structured_output import _parse_and_validate_structured_output
from graphon.model_runtime.entities.llm_entities import LLMStructuredOutput, LLMUsage
from graphon.nodes.llm import LLMNode
from graphon.nodes.llm.exc import LLMNodeError


class DifyLLMNode(LLMNode):
    """Dify-owned LLM node adapter for stricter workflow contracts."""

    def _recover_structured_output_from_text(self, *, clean_text: str) -> LLMStructuredOutput | None:
        raw_structured_output = getattr(self.node_data, "structured_output", None)
        if raw_structured_output is None:
            return None

        try:
            output_schema = self.fetch_structured_output_schema(structured_output=raw_structured_output)
            parsed_output = _parse_and_validate_structured_output(
                result_text=clean_text,
                json_schema=output_schema,
            )
        except (LLMNodeError, OutputParserError):
            return None

        return LLMStructuredOutput(structured_output=parsed_output)

    def _build_run_outputs(
        self,
        *,
        clean_text: str,
        usage: LLMUsage,
        finish_reason: str | None,
        reasoning_content: str,
        structured_output: LLMStructuredOutput | None,
    ) -> dict[str, Any]:
        if structured_output is None:
            structured_output = self._recover_structured_output_from_text(clean_text=clean_text)

        if self.node_data.structured_output_enabled and structured_output is None:
            raise LLMNodeError(
                "Structured output is enabled, but the model response did not produce a valid structured_output. "
                "Check the model response and the configured JSON schema."
            )

        return super()._build_run_outputs(
            clean_text=clean_text,
            usage=usage,
            finish_reason=finish_reason,
            reasoning_content=reasoning_content,
            structured_output=structured_output,
        )
