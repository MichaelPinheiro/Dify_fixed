from __future__ import annotations

from typing import Any

from graphon.model_runtime.entities.model_entities import ModelType
from graphon.model_runtime.model_providers.base.ai_model import AIModel
from graphon.model_runtime.model_providers.base.large_language_model import LargeLanguageModel
from graphon.model_runtime.model_providers.base.moderation_model import ModerationModel
from graphon.model_runtime.model_providers.base.rerank_model import RerankModel
from graphon.model_runtime.model_providers.base.speech2text_model import Speech2TextModel
from graphon.model_runtime.model_providers.base.text_embedding_model import TextEmbeddingModel
from graphon.model_runtime.model_providers.base.tts_model import TTSModel
from graphon.model_runtime.model_providers.model_provider_factory import (
    ModelProviderFactory as GraphonModelProviderFactory,
)

_MODEL_TYPE_TO_CLASS: dict[ModelType, type[AIModel[Any]]] = {
    ModelType.LLM: LargeLanguageModel,
    ModelType.TEXT_EMBEDDING: TextEmbeddingModel,
    ModelType.RERANK: RerankModel,
    ModelType.SPEECH2TEXT: Speech2TextModel,
    ModelType.MODERATION: ModerationModel,
    ModelType.TTS: TTSModel,
}


class ModelProviderFactory(GraphonModelProviderFactory):
    """
    Backward-compatible provider factory for Dify's model runtime flows.

    Graphon 0.4 removed ``get_model_type_instance`` from its upstream factory,
    while Dify still relies on that method in several orchestration paths.
    This adapter keeps using Graphon's provider/schema behavior and restores the
    model instance constructor in one place during the migration.
    """

    def get_model_type_instance(self, provider: str, model_type: ModelType | str) -> AIModel[Any]:
        normalized_model_type = self._normalize_model_type(model_type)
        provider_schema = self.get_model_provider(provider=provider)

        if normalized_model_type not in provider_schema.supported_model_types:
            raise ValueError(
                f"Provider {provider_schema.provider} does not support model type: {normalized_model_type.value}"
            )

        model_class = _MODEL_TYPE_TO_CLASS.get(normalized_model_type)
        if model_class is None:
            raise ValueError(f"Unsupported model type: {model_type}")

        return model_class(provider_schema=provider_schema, model_runtime=self.runtime)

    @staticmethod
    def _normalize_model_type(model_type: ModelType | str) -> ModelType:
        if isinstance(model_type, ModelType):
            return model_type

        try:
            return ModelType.value_of(model_type)
        except ValueError as exc:
            raise ValueError(f"Unsupported model type: {model_type}") from exc
