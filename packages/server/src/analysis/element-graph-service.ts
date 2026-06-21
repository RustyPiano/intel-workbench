import type { ElementGraph, Identity } from "../domain/types.js";
import type { ElementService } from "../elements/element-service.js";
import { buildElementGraph } from "./element-graph.js";

export class ElementGraphService {
  constructor(private readonly elements: ElementService) {}

  async graph(actor: Identity, caseId: string): Promise<ElementGraph> {
    const els = await this.elements.get(actor, caseId);
    return buildElementGraph(els);
  }
}
