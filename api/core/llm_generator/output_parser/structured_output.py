import json
from collections.abc import Generator, Mapping, Sequence
from copy import deepcopy
from enum import StrEnum
from typing import Any, Literal, cast, overload

import json_repair
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from pydantic import TypeAdapter, ValidationError

from core.llm_generator.output_parser.errors import OutputParserError
from core.llm_generator.prompts import STRUCTURED_OUTPUT_PROMPT
from core.model_manager import ModelInstance
from graphon.model_runtime.callbacks.base_callback import Callback
from graphon.model_runtime.entities.llm_entities import (
    LLMResult,
    LLMResultChunk,
    LLMResultChunkDelta,
    LLMResultChunkWithStructuredOutput,
    LLMResultWithStructuredOutput,
)
from graphon.model_runtime.entities.message_entities import (
    AssistantPromptMessage,
    PromptMessage,
    PromptMessageTool,
    SystemPromptMessage,
    TextPromptMessageContent,
)
from graphon.model_runtime.entities.model_entities import AIModelEntity, ParameterRule


class ResponseFormat(StrEnum):
    """Constants for model response formats"""

    JSON_SCHEMA = "json_schema"  # model's structured output mode. some model like gemini, gpt-4o,  support this mode.
    JSON = "JSON"  # model's json mode. some model like claude support this mode.
    JSON_OBJECT = "json_object"  # json mode's another alias. some model like deepseek-chat, qwen use this alias.


class SpecialModelType(StrEnum):
    """Constants for identifying model types"""

    GEMINI = "gemini"
    OLLAMA = "ollama"


@overload
def invoke_llm_with_structured_output(
    *,
    provider: str,
    model_schema: AIModelEntity,
    model_instance: ModelInstance,
    prompt_messages: Sequence[PromptMessage],
    json_schema: Mapping[str, Any],
    model_parameters: Mapping | None = None,
    tools: Sequence[PromptMessageTool] | None = None,
    stop: list[str] | None = None,
    stream: Literal[True],
    callbacks: list[Callback] | None = None,
) -> Generator[LLMResultChunkWithStructuredOutput, None, None]: ...
@overload
def invoke_llm_with_structured_output(
    *,
    provider: str,
    model_schema: AIModelEntity,
    model_instance: ModelInstance,
    prompt_messages: Sequence[PromptMessage],
    json_schema: Mapping[str, Any],
    model_parameters: Mapping | None = None,
    tools: Sequence[PromptMessageTool] | None = None,
    stop: list[str] | None = None,
    stream: Literal[False],
    callbacks: list[Callback] | None = None,
) -> LLMResultWithStructuredOutput: ...
@overload
def invoke_llm_with_structured_output(
    *,
    provider: str,
    model_schema: AIModelEntity,
    model_instance: ModelInstance,
    prompt_messages: Sequence[PromptMessage],
    json_schema: Mapping[str, Any],
    model_parameters: Mapping | None = None,
    tools: Sequence[PromptMessageTool] | None = None,
    stop: list[str] | None = None,
    stream: bool = True,
    callbacks: list[Callback] | None = None,
) -> LLMResultWithStructuredOutput | Generator[LLMResultChunkWithStructuredOutput, None, None]: ...
def invoke_llm_with_structured_output(
    *,
    provider: str,
    model_schema: AIModelEntity,
    model_instance: ModelInstance,
    prompt_messages: Sequence[PromptMessage],
    json_schema: Mapping[str, Any],
    model_parameters: Mapping | None = None,
    tools: Sequence[PromptMessageTool] | None = None,
    stop: list[str] | None = None,
    stream: bool = True,
    callbacks: list[Callback] | None = None,
) -> LLMResultWithStructuredOutput | Generator[LLMResultChunkWithStructuredOutput, None, None]:
    """
    Invoke large language model with structured output
    1. This method invokes model_instance.invoke_llm with json_schema
    2. Try to parse the result as structured output

    :param prompt_messages: prompt messages
    :param json_schema: json schema
    :param model_parameters: model parameters
    :param tools: tools for tool calling
    :param stop: stop words
    :param stream: is stream response
    :param callbacks: callbacks
    :return: full response or stream response chunk generator result
    """

    # handle native json schema
    model_parameters_with_json_schema: dict[str, Any] = {
        **(model_parameters or {}),
    }

    if model_schema.support_structure_output:
        model_parameters = _handle_native_json_schema(
            provider, model_schema, json_schema, model_parameters_with_json_schema, model_schema.parameter_rules
        )
    else:
        # Set appropriate response format based on model capabilities
        _set_response_format(model_parameters_with_json_schema, model_schema.parameter_rules)

        # handle prompt based schema
        prompt_messages = _handle_prompt_based_schema(
            prompt_messages=prompt_messages,
            structured_output_schema=json_schema,
        )

    llm_result = model_instance.invoke_llm(
        prompt_messages=list(prompt_messages),
        model_parameters=model_parameters_with_json_schema,
        tools=tools,
        stop=stop,
        stream=stream,
        callbacks=callbacks,
    )

    if isinstance(llm_result, LLMResult):
        if not isinstance(llm_result.message.content, str):
            raise OutputParserError(
                f"Failed to parse structured output, LLM result is not a string: {llm_result.message.content}"
            )

        return LLMResultWithStructuredOutput(
            structured_output=_parse_and_validate_structured_output(
                result_text=llm_result.message.content,
                json_schema=json_schema,
            ),
            model=llm_result.model,
            message=llm_result.message,
            usage=llm_result.usage,
            system_fingerprint=llm_result.system_fingerprint,
            prompt_messages=llm_result.prompt_messages,
        )
    else:

        def generator() -> Generator[LLMResultChunkWithStructuredOutput, None, None]:
            result_text: str = ""
            prompt_messages: Sequence[PromptMessage] = []
            system_fingerprint: str | None = None
            for event in llm_result:
                if isinstance(event, LLMResultChunk):
                    prompt_messages = event.prompt_messages
                    system_fingerprint = event.system_fingerprint

                    if isinstance(event.delta.message.content, str):
                        result_text += event.delta.message.content
                    elif isinstance(event.delta.message.content, list):
                        for item in event.delta.message.content:
                            if isinstance(item, TextPromptMessageContent):
                                result_text += item.data

                yield LLMResultChunkWithStructuredOutput(
                    model=model_schema.model,
                    prompt_messages=prompt_messages,
                    system_fingerprint=system_fingerprint,
                    delta=event.delta,
                )

            yield LLMResultChunkWithStructuredOutput(
                structured_output=_parse_and_validate_structured_output(
                    result_text=result_text,
                    json_schema=json_schema,
                ),
                model=model_schema.model,
                prompt_messages=prompt_messages,
                system_fingerprint=system_fingerprint,
                delta=LLMResultChunkDelta(
                    index=0,
                    message=AssistantPromptMessage(content=""),
                    usage=None,
                    finish_reason=None,
                ),
            )

        return generator()


def _parse_and_validate_structured_output(
    *,
    result_text: str,
    json_schema: Mapping[str, Any],
) -> Mapping[str, Any]:
    structured_output = _parse_structured_output(result_text)
    _validate_structured_output_schema(
        structured_output=structured_output,
        json_schema=json_schema,
    )
    return structured_output


def _handle_native_json_schema(
    provider: str,
    model_schema: AIModelEntity,
    structured_output_schema: Mapping,
    model_parameters: dict[str, Any],
    rules: list[ParameterRule],
) -> dict[str, Any]:
    """
    Handle structured output for models with native JSON schema support.

    :param model_parameters: Model parameters to update
    :param rules: Model parameter rules
    :return: Updated model parameters with JSON schema configuration
    """
    # Process schema according to model requirements
    schema_json = _prepare_schema_for_model(provider, model_schema, structured_output_schema)

    # Set JSON schema in parameters
    model_parameters["json_schema"] = json.dumps(schema_json, ensure_ascii=False)

    # Set appropriate response format if required by the model
    for rule in rules:
        if rule.name == "response_format" and ResponseFormat.JSON_SCHEMA in rule.options:
            model_parameters["response_format"] = ResponseFormat.JSON_SCHEMA

    return model_parameters


def _set_response_format(model_parameters: dict[str, Any], rules: list[ParameterRule]) -> None:
    """
    Set the appropriate response format parameter based on model rules.

    :param model_parameters: Model parameters to update
    :param rules: Model parameter rules
    """
    for rule in rules:
        if rule.name == "response_format":
            if ResponseFormat.JSON in rule.options:
                model_parameters["response_format"] = ResponseFormat.JSON
            elif ResponseFormat.JSON_OBJECT in rule.options:
                model_parameters["response_format"] = ResponseFormat.JSON_OBJECT


def _handle_prompt_based_schema(
    prompt_messages: Sequence[PromptMessage], structured_output_schema: Mapping
) -> list[PromptMessage]:
    """
    Handle structured output for models without native JSON schema support.
    This function modifies the prompt messages to include schema-based output requirements.

    Args:
        prompt_messages: Original sequence of prompt messages

    Returns:
        list[PromptMessage]: Updated prompt messages with structured output requirements
    """
    # Convert schema to string format
    schema_str = json.dumps(structured_output_schema, ensure_ascii=False)

    # Find existing system prompt with schema placeholder
    system_prompt = next(
        (prompt for prompt in prompt_messages if isinstance(prompt, SystemPromptMessage)),
        None,
    )
    structured_output_prompt = STRUCTURED_OUTPUT_PROMPT.replace("{{schema}}", schema_str)
    # Prepare system prompt content
    system_prompt_content = (
        structured_output_prompt + "\n\n" + system_prompt.content
        if system_prompt and isinstance(system_prompt.content, str)
        else structured_output_prompt
    )
    system_prompt = SystemPromptMessage(content=system_prompt_content)

    # Extract content from the last user message

    filtered_prompts = [prompt for prompt in prompt_messages if not isinstance(prompt, SystemPromptMessage)]
    updated_prompt = [system_prompt] + filtered_prompts

    return updated_prompt


def _parse_structured_output(result_text: str) -> Mapping[str, Any]:
    try:
        parsed = TypeAdapter(dict[str, Any]).validate_json(result_text)
    except ValidationError:
        # if the result_text is not a valid json, try to repair it
        temp_parsed = json_repair.loads(result_text)
        if not isinstance(temp_parsed, dict):
            raise OutputParserError(f"Failed to parse structured output as JSON object: {result_text}")
        parsed = cast(dict[str, Any], temp_parsed)

    if not isinstance(parsed, dict):
        raise OutputParserError(f"Failed to parse structured output as JSON object: {result_text}")

    return parsed


def _validate_structured_output_schema(
    *,
    structured_output: Mapping[str, Any],
    json_schema: Mapping[str, Any],
) -> None:
    schema = _normalize_structured_output_schema(json_schema)
    try:
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema=schema)
    except SchemaError as exc:
        raise OutputParserError(f"Invalid structured output schema: {exc.message}") from exc

    validation_error = next(validator.iter_errors(structured_output), None)
    if validation_error is None:
        return

    path = ".".join(str(part) for part in validation_error.path)
    location = path if path else "<root>"
    raise OutputParserError(
        f"Structured output does not match schema at {location}: {validation_error.message}"
    )


def _normalize_structured_output_schema(schema: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize Dify visual-editor schemas into strict runtime schemas.

    The visual editor exposes declared object properties as selectable workflow
    variables. If those properties are optional at JSON-schema level, downstream
    nodes can select e.g. `structured_output.route` and then fail later because
    the model legally omitted `route`. Treat declared object properties as
    required unless the schema author explicitly provided a `required` list.
    """
    normalized = dict(deepcopy(schema))
    _require_declared_object_properties(normalized)
    return normalized


def _require_declared_object_properties(schema: dict[str, Any]) -> None:
    if not isinstance(schema, dict):
        return

    properties = schema.get("properties")
    if schema.get("type") == "object" and isinstance(properties, dict):
        if "required" not in schema:
            schema["required"] = list(properties.keys())

        for property_schema in properties.values():
            if isinstance(property_schema, dict):
                _require_declared_object_properties(property_schema)
            elif isinstance(property_schema, list):
                for item in property_schema:
                    if isinstance(item, dict):
                        _require_declared_object_properties(item)

    for key in ("items", "anyOf", "oneOf", "allOf"):
        value = schema.get(key)
        if isinstance(value, dict):
            _require_declared_object_properties(value)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    _require_declared_object_properties(item)


def _prepare_schema_for_model(provider: str, model_schema: AIModelEntity, schema: Mapping):
    """
    Prepare JSON schema based on model requirements.

    Different models have different requirements for JSON schema formatting.
    This function handles these differences.

    :param schema: The original JSON schema
    :return: Processed schema compatible with the current model
    """

    # Deep copy to avoid modifying the original schema
    processed_schema = _normalize_structured_output_schema(schema)

    # Convert boolean types to string types (common requirement)
    convert_boolean_to_string(processed_schema)

    # Apply model-specific transformations
    if SpecialModelType.GEMINI in model_schema.model:
        remove_additional_properties(processed_schema)
        return processed_schema
    elif SpecialModelType.OLLAMA in provider:
        return processed_schema
    else:
        # Default format with name field
        return {"schema": processed_schema, "name": "llm_response"}


def remove_additional_properties(schema: dict[str, Any]) -> None:
    """
    Remove additionalProperties fields from JSON schema.
    Used for models like Gemini that don't support this property.

    :param schema: JSON schema to modify in-place
    """
    if not isinstance(schema, dict):
        return

    # Remove additionalProperties at current level
    schema.pop("additionalProperties", None)

    # Process nested structures recursively
    for value in schema.values():
        if isinstance(value, dict):
            remove_additional_properties(value)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    remove_additional_properties(item)


def convert_boolean_to_string(schema: dict[str, Any]) -> None:
    """
    Convert boolean type specifications to string in JSON schema.

    :param schema: JSON schema to modify in-place
    """
    if not isinstance(schema, dict):
        return

    # Check for boolean type at current level
    if schema.get("type") == "boolean":
        schema["type"] = "string"

    # Process nested dictionaries and lists recursively
    for value in schema.values():
        if isinstance(value, dict):
            convert_boolean_to_string(value)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    convert_boolean_to_string(item)
