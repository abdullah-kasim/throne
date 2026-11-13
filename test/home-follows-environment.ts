import os from "node:os";

const accountHome = os.homedir();
os.homedir = () => process.env.HOME || accountHome;
