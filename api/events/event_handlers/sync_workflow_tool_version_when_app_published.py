import logging
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from core.tools.utils.workflow_configuration_sync import WorkflowToolConfigurationUtils
from events.app_event import app_published_workflow_was_updated
from extensions.ext_database import db
from models import AppMode
from models.tools import WorkflowToolProvider
from models.workflow import Workflow

logger = logging.getLogger(__name__)


@app_published_workflow_was_updated.connect
def handle(sender, **kwargs):
    """
    Keep workflow-tool provider version aligned with the newest published workflow.

    The sync is applied only when the input contract remains compatible. If the
    contract changes, the provider intentionally remains outdated so the UI can
    prompt explicit reconfiguration.
    """
    app = sender
    if app.mode != AppMode.WORKFLOW.value:
        return

    published_workflow = kwargs.get("published_workflow")
    published_workflow = cast(Workflow | None, published_workflow)
    if published_workflow is None:
        return

    try:
        with sessionmaker(db.engine).begin() as session:
            workflow_tool_provider = session.scalar(
                select(WorkflowToolProvider)
                .where(
                    WorkflowToolProvider.tenant_id == app.tenant_id,
                    WorkflowToolProvider.app_id == app.id,
                )
                .limit(1)
            )
            if workflow_tool_provider is None:
                return

            if workflow_tool_provider.version == published_workflow.version:
                return

            previous_workflow = session.scalar(
                select(Workflow)
                .where(
                    Workflow.app_id == app.id,
                    Workflow.version == workflow_tool_provider.version,
                )
                .limit(1)
            )
            if previous_workflow is None:
                logger.warning(
                    "Skip workflow tool version sync because previous workflow version was not found: "
                    "app_id=%s, provider_id=%s, provider_version=%s, published_version=%s",
                    app.id,
                    workflow_tool_provider.id,
                    workflow_tool_provider.version,
                    published_workflow.version,
                )
                return

            current_variables = WorkflowToolConfigurationUtils.get_workflow_graph_variables(
                published_workflow.graph_dict
            )
            previous_variables = WorkflowToolConfigurationUtils.get_workflow_graph_variables(
                previous_workflow.graph_dict
            )

            WorkflowToolConfigurationUtils.check_is_synced(
                variables=list(current_variables),
                tool_configurations=workflow_tool_provider.parameter_configurations,
            )
            WorkflowToolConfigurationUtils.ensure_input_contract_compatible(
                previous_variables=previous_variables,
                current_variables=current_variables,
            )

            workflow_tool_provider.version = published_workflow.version
            session.add(workflow_tool_provider)
            logger.info(
                "Auto-synced workflow tool provider version after publish: app_id=%s, provider_id=%s, "
                "new_version=%s",
                app.id,
                workflow_tool_provider.id,
                published_workflow.version,
            )
    except ValueError as ex:
        logger.info(
            "Workflow tool provider remains outdated after publish due to incompatible contract: "
            "app_id=%s, published_workflow_id=%s, reason=%s",
            app.id,
            published_workflow.id,
            ex,
        )
    except Exception:
        logger.exception(
            "Failed to auto-sync workflow tool provider version after publish: app_id=%s, "
            "published_workflow_id=%s",
            app.id,
            published_workflow.id,
        )
