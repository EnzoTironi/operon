import type {
  MultiDatasetObjectMapping,
  ObjectInstance,
  ObjectProperties,
  RestrictedView,
  Subject,
} from "@operon/schema";

/**
 * Evaluates Dynamic Security: Restricted Views (RVs) & Multi-Dataset Objects (MDOs)
 */
export class DynamicSecurityEngine {
  private readonly restrictedViews = new Map<string, RestrictedView[]>();
  private readonly mdoMappings = new Map<string, MultiDatasetObjectMapping>();

  registerRestrictedView(rv: RestrictedView): void {
    const list = this.restrictedViews.get(rv.objectTypeId) ?? [];
    list.push(rv);
    this.restrictedViews.set(rv.objectTypeId, list);
  }

  registerMdoMapping(mdo: MultiDatasetObjectMapping): void {
    this.mdoMappings.set(mdo.objectTypeId, mdo);
  }

  /**
   * Check if a subject has read access to an object instance based on Restricted Views
   */
  canRead(instance: ObjectInstance, subject: Subject): boolean {
    const rvs = this.restrictedViews.get(instance.typeId);
    if (!rvs || rvs.length === 0) {
      return true;
    }
    return rvs.every((rv) => rv.predicate(instance, subject));
  }

  /**
   * Filter objects using Restricted Views (Row-level security)
   */
  filterInstances(
    instances: readonly ObjectInstance[],
    subject: Subject
  ): readonly ObjectInstance[] {
    return instances.filter((inst) => this.canRead(inst, subject));
  }

  /**
   * Mask or redact properties based on Multi-Dataset Object (MDO) classifications (Column-level security)
   */
  projectInstance(instance: ObjectInstance, subject: Subject): ObjectInstance {
    const mdo = this.mdoMappings.get(instance.typeId);
    if (!mdo) {
      return instance;
    }

    const projectedProps: ObjectProperties = {};
    for (const [propName, val] of Object.entries(instance.properties)) {
      const classification = mdo.propertyClassifications[propName] ?? "public";
      const authorizedRoles =
        mdo.authorizedRolesPerClassification[classification] ?? [];

      const isAuthorized =
        classification === "public" ||
        subject.roles.includes("admin") ||
        subject.roles.some((r) => authorizedRoles.includes(r));

      projectedProps[propName] = isAuthorized
        ? val
        : "[REDACTED_BY_SECURITY_POLICY]";
    }

    return {
      ...instance,
      properties: projectedProps,
    };
  }
}
