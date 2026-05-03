import { Router, type IRouter } from "express";
import healthRouter from "./health";
import languageRouter from "./language";
import syncRouter from "./sync";

const router: IRouter = Router();

router.use(healthRouter);
router.use(syncRouter);
router.use(languageRouter);

export default router;
