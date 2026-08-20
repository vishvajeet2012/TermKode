import { useCallback, useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import type { InferResponseType } from "hono/client";
import { apiClient } from "../../lib/api-client";
import { getErrorMessage } from "../../lib/http-errors";
import { useDialog } from "../../providers/dialog";
import { DialogSearchList } from "../dialog-search-list";

type ModelsResponse = InferResponseType<typeof apiClient.providers.models.$get, 200>;
type ModelOption = ModelsResponse["models"][number];

type ModelsDialogContentProps = {
    onSelectModel: (ref: string) => void;
};

// The list is whatever the configured providers report right now, so new models
// appear without updating TermKode.
export const ModelsDialogContent = ({ onSelectModel }: ModelsDialogContentProps) => {
    const dialog = useDialog();
    const [models, setModels] = useState<ModelOption[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let ignore = false;

        const load = async () => {
            try {
                const response = await apiClient.providers.models.$get();
                if (!response.ok) throw new Error(await getErrorMessage(response));

                const data = await response.json();
                if (!ignore) setModels(data.models);
            } catch (cause) {
                if (!ignore) {
                    setError(cause instanceof Error ? cause.message : "Failed to load models");
                }
            }
        };

        void load();
        return () => {
            ignore = true;
        };
    }, []);

    const handleSelect = useCallback(
        (option: ModelOption) => {
            onSelectModel(option.ref);
            dialog.close();
        },
        [onSelectModel, dialog],
    );

    if (error) {
        return <text fg="red">{error}</text>;
    }

    if (!models) {
        return <text attributes={TextAttributes.DIM}>Loading models...</text>;
    }

    if (models.length === 0) {
        return (
            <text attributes={TextAttributes.DIM}>
                No providers configured yet. Run /providers to add an API key or start a local AI server.
            </text>
        );
    }

    return (
        <DialogSearchList
            items={models}
            onSelect={handleSelect}
            filterFn={(option, query) => {
                const needle = query.toLowerCase();
                return (
                    option.modelId.toLowerCase().includes(needle) ||
                    option.providerLabel.toLowerCase().includes(needle)
                );
            }}
            renderItem={(option, isSelected) => (
                <>
                    <text selectable={false} fg={isSelected ? "black" : "white"}>
                        {option.modelId}
                    </text>
                    <box flexGrow={1} />
                    <text
                        selectable={false}
                        fg={isSelected ? "black" : undefined}
                        attributes={TextAttributes.DIM}
                    >
                        {option.providerLabel}
                    </text>
                </>
            )}
            getKey={(option) => option.ref}
            placeholder="Search models"
            emptyText="No matching models"
        />
    );
};
