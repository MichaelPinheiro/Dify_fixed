from collections.abc import Mapping, Sequence
from typing import Any

from core.tools.entities.tool_entities import ToolParameter, WorkflowToolParameterConfiguration
from core.tools.errors import WorkflowToolHumanInputNotSupportedError
from graphon.enums import BuiltinNodeTypes
from graphon.nodes.base.entities import OutputVariableEntity
from graphon.variables.input_entities import VariableEntity, VariableEntityType

VARIABLE_TO_PARAMETER_TYPE_MAPPING = {
    VariableEntityType.TEXT_INPUT: ToolParameter.ToolParameterType.STRING,
    VariableEntityType.PARAGRAPH: ToolParameter.ToolParameterType.STRING,
    VariableEntityType.SELECT: ToolParameter.ToolParameterType.SELECT,
    VariableEntityType.NUMBER: ToolParameter.ToolParameterType.NUMBER,
    VariableEntityType.CHECKBOX: ToolParameter.ToolParameterType.BOOLEAN,
    VariableEntityType.FILE: ToolParameter.ToolParameterType.FILE,
    VariableEntityType.FILE_LIST: ToolParameter.ToolParameterType.FILES,
    VariableEntityType.JSON_OBJECT: ToolParameter.ToolParameterType.OBJECT,
}


class WorkflowToolConfigurationUtils:
    @classmethod
    def get_workflow_graph_variables(cls, graph: Mapping[str, Any]) -> Sequence[VariableEntity]:
        """
        get workflow graph variables
        """
        nodes = graph.get("nodes", [])
        start_node = next(filter(lambda x: x.get("data", {}).get("type") == "start", nodes), None)
        if not start_node:
            return []
        return [VariableEntity.model_validate(variable) for variable in start_node.get("data", {}).get("variables", [])]

    @classmethod
    def get_workflow_graph_output(cls, graph: Mapping[str, Any]) -> Sequence[OutputVariableEntity]:
        """
        get workflow graph output
        """
        nodes = graph.get("nodes", [])
        outputs_by_variable: dict[str, OutputVariableEntity] = {}
        variable_order: list[str] = []

        for node in nodes:
            if node.get("data", {}).get("type") != "end":
                continue

            for output in node.get("data", {}).get("outputs", []):
                entity = OutputVariableEntity.model_validate(output)
                variable = entity.variable

                if variable not in variable_order:
                    variable_order.append(variable)

                # Later end nodes override duplicated variable definitions.
                outputs_by_variable[variable] = entity

        return [outputs_by_variable[variable] for variable in variable_order]

    @classmethod
    def ensure_no_human_input_nodes(cls, graph: Mapping[str, Any]) -> None:
        nodes = graph.get("nodes", [])
        for node in nodes:
            if node.get("data", {}).get("type") == BuiltinNodeTypes.HUMAN_INPUT:
                raise WorkflowToolHumanInputNotSupportedError()

    @classmethod
    def check_is_synced(
        cls, variables: list[VariableEntity], tool_configurations: list[WorkflowToolParameterConfiguration]
    ):
        """
        check is synced

        raise ValueError if not synced
        """
        variable_names = [variable.variable for variable in variables]

        if len(tool_configurations) != len(variables):
            raise ValueError("parameter configuration mismatch, please republish the tool to update")

        for parameter in tool_configurations:
            if parameter.name not in variable_names:
                raise ValueError("parameter configuration mismatch, please republish the tool to update")

    @classmethod
    def ensure_input_contract_compatible(
        cls, *, previous_variables: Sequence[VariableEntity], current_variables: Sequence[VariableEntity]
    ) -> None:
        """
        Ensure workflow input contract compatibility across published versions.

        The contract is considered compatible only when all parameters keep:
        - the same variable name set
        - the same required flag
        - the same mapped tool parameter type
        """

        previous_by_name = {variable.variable: variable for variable in previous_variables}
        current_by_name = {variable.variable: variable for variable in current_variables}

        if set(previous_by_name) != set(current_by_name):
            raise ValueError("input variable set changed, please reconfigure workflow tool")

        for variable_name, previous_variable in previous_by_name.items():
            current_variable = current_by_name[variable_name]
            previous_type = VARIABLE_TO_PARAMETER_TYPE_MAPPING.get(previous_variable.type)
            current_type = VARIABLE_TO_PARAMETER_TYPE_MAPPING.get(current_variable.type)
            if previous_type is None or current_type is None:
                raise ValueError("unsupported variable type change, please reconfigure workflow tool")
            if previous_type != current_type:
                raise ValueError("input variable type changed, please reconfigure workflow tool")
            if previous_variable.required != current_variable.required:
                raise ValueError("input variable required flag changed, please reconfigure workflow tool")
