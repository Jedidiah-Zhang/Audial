import { Router, type IRouter } from "express";
import healthRouter from "./health";
import languageRouter from "./language";

const router: IRouter = Router();

router.use(healthRouter);
router.use(languageRouter);

export default router;
