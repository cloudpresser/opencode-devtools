import { testWorkflowLifecycle } from "../testing";
import { planWorkflow } from "./index";

testWorkflowLifecycle({
  workflow: planWorkflow,
});
