import type { PropertyDefinition } from "./object-type.js";

export interface InterfaceType<
  Props extends Record<string, PropertyDefinition<unknown>> = Record<
    string,
    PropertyDefinition<unknown>
  >,
> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly properties: Props;
}

export function defineInterfaceType<
  Props extends Record<string, PropertyDefinition<unknown>>,
>(config: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly properties: Props;
}): InterfaceType<Props> {
  return config;
}
