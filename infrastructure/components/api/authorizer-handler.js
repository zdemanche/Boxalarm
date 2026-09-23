// Fail-closed placeholder until backend authorizer artifact is packaged.
// Real handler: boxalarm-backend platform-service/authorizer
exports.handler = async (event) => {
  console.log(
    JSON.stringify({
      msg: "authorizer stub deny",
      hasAuth: Boolean(event.headers?.authorization || event.headers?.Authorization),
    }),
  );
  return { isAuthorized: false };
};
