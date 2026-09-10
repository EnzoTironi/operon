import type { PropertyDefinition } from "./object-type.js";

export interface InterfaceType<
  Props extends Record<string, PropertyDefinition<any>> = Record<
    string,
    PropertyDefinition<any>
  >,
> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly properties: Props;
}

export function defineInterfaceType<
  Props extends Record<string, PropertyDefinition<any>>,
>(config: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly properties: Props;
}): InterfaceType<Props> {
  return config;
}
