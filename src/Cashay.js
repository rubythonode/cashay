import {INSERT_NORMALIZED} from './normalize/duck';
import denormalizeStore from './normalize/denormalizeStore';
import {rebuildOriginalArgs} from './normalize/denormalizeHelpers';
import normalizeResponse from './normalize/normalizeResponse';
import {printMinimalQuery} from './query/printMinimalQuery';
import {shortenNormalizedResponse, invalidateMutationsOnNewQuery} from './query/queryHelpers';
import {isObject, checkMutationInSchema} from './utils';
import mergeStores from './normalize/mergeStores';
import {CachedMutation, CachedQuery, MutationShell} from './helperClasses';
import flushDependencies from './query/flushDependencies';
import {makeComponentsToUpdate} from './mutate/mutationHelpers';
import {parse, equalObjectKeys, buildExecutionContext} from './utils';
import namespaceMutation from './mutate/namespaceMutation';
import mergeMutations from './mutate/mergeMutations';
import createMutationFromQuery from './mutate/createMutationFromQuery';
import removeNamespacing from './mutate/removeNamespacing';
import addDeps from './normalize/addDeps';

const defaultGetToState = store => store.getState().cashay;
const defaultPaginationWords = {
  before: 'before',
  after: 'after',
  first: 'first',
  last: 'last'
};

export default class Cashay {
  constructor({store, transport, schema, getToState = defaultGetToState, paginationWords, idFieldName = 'id'}) {
    // the redux store
    this.store = store;

    //the cashay state
    this.getState = () => getToState(store);

    // the reserved arguments for cusor-based pagination
    this.paginationWords = Object.assign({}, defaultPaginationWords, paginationWords);

    // the field that contains the UID
    this.idFieldName = idFieldName;

    // the default function to send the queryString to the server (usually HTTP or WS)
    this.transport = transport;

    // the client graphQL schema
    this.schema = schema;

    // many mutations can share the same mutationName, making it hard to cache stuff without adding complexity
    // we can assume that a mutationName + the components it affects = a unique, reproduceable fullMutation
    // const example = {
    //   [mutationName]: {
    //     activeComponentsObj: {},
    //     fullMutation: MutationString,
    //     variableEnhancers: [],
    //     singles: {
    //       [component]: {
    //          ast: MutationAST,
    //          variableEnhancers: []
    //       }
    //     }
    //   }
    // }
    this.cachedMutations = {};

    // the object to hold the denormalized query responses
    // const example = {
    //   [component]: {
    //     ast,
    //     refetch: FunctionToRefetchQuery,
    //     response: DenormalizedResponse,
    //     response: {
    //       [key]: DenormalizedResponse // if a key exists
    //     }
    //   }
    // }
    this.cachedQueries = {};

    // a flag thrown by the invalidate function and reset when that query is added to the queue
    this._willInvalidateListener = false;

    // const example = {
    //   [mutationName]: {
    //     [component]: mutationHandlerFn
    //   }
    // }
    this.mutationHandlers = {};

    // denormalized deps is an object with entities for keys. 
    // The value of each entity is an object with uids for keys.
    // the value of each UID is a set of components
    // const example = {
    //   Pets: {
    //     1: {
    //       [component]: ['key1', 'key2']
    //     }
    //   }
    // }
    this.denormalizedDeps = {};

    // not stored in _cachedQueries in able to compare old vs new deps
    // const example = {
    //   [component]: Set(...['Pets.1', 'Pets.2']),
    //   [ifKeyComponent]: {
    //     [key]: Set(...['Pets.1', 'Pets.2'])
    //   }
    // }
    this.normalizedDeps = {};
  }

  /**
   * a method given to a mutation callback that turns on a global.
   * if true, then we know to queue up a requery
   */
  _invalidate() {
    this._willInvalidateListener = true;
  }

  /**
   * A method that accepts a GraphQL query and returns a result using only local data.
   * If it cannot complete the request on local data alone, it also asks the server for the data that it does not have.
   *
   * @param {String} queryString The GraphQL query string, exactly as you'd send it to a GraphQL server
   * @param {Object} options The optional objects to include with the query
   *
   * @property {String} options.component A string to match the component.
   * @property {String} options.key A string to uniquely match the component insance.
   * @property {Boolean} options.forceFetch is true if the query is to ignore all local data and fetch new data
   * @property {Function} options.transport The function used to send the data request to GraphQL, if different from default
   * @property {Object} options.variables are the variables sent along with the query
   * @property {Object} options.mutationHandlers the functions used to change the local data when a mutation occurs
   * @property {Object} options.customMutations if mutations are too complex to be autogenerated (rare), write them here
   *
   * @returns {Object} The denormalized object like GraphQL would return, with additional `isComplete` and `firstRun` flags
   *
   */
  query(queryString, options = {}) {
    //if you call forceFetch in a mapStateToProps, you're gonna have a bad time (it'll refresh on EVERY dispatch)
    const {key} = options;
    const forceFetch = Boolean(options.forceFetch);
    // Each component can have only 1 unique queryString/variable combo. This keeps memory use minimal.
    // if 2 components have the same queryString/variable but a different component, it'll fetch twice
    const component = options.component || queryString;
    // get the result, containing a response, queryString, and options to re-call the query
    const fastResult = this.cachedQueries[component];
    // if we got local data cached already, send it back fast
    if (!forceFetch && fastResult && fastResult.response) {
      if (!key) {
        return fastResult.response;
      } else if (fastResult.response[key]) {
        return fastResult.response[key];
      }
    }
    const cashayDataState = this.getState().data;
    // override singleton defaults with query-specific values
    const componentVars = cashayDataState.variables[component];
    let stateVars;
    if (componentVars) {
      stateVars = key ? componentVars[key] : componentVars;
    }
    const variables = stateVars || options.variables;

    const transport = options.transport || this.transport;

    // save the query so we can call it from anywhere
    if (!fastResult) {
      this.cachedQueries[component] = new CachedQuery(this.query, queryString, this.schema, this.idFieldName, {
        transport,
        forceFetch: true
      });
      invalidateMutationsOnNewQuery(component, this.cachedMutations);

    }
    const cachedQuery = this.cachedQueries[component];

    // create an AST that we can mutate
    const {paginationWords, idFieldName, schema} = this;
    const context = buildExecutionContext(cachedQuery.ast, {
      cashayDataState,
      variables,
      paginationWords,
      idFieldName,
      schema
    });
    // create a response with a denormalized response and a function to set the variables
    cachedQuery.createResponse(context, component, key, this.store.dispatch, forceFetch);
    const cachedResponse = key ? cachedQuery.response[key] : cachedQuery.response;

    // if this is a different query string but the same base query
    // eg in this one we request 1 more field
    // we'll want to add dependencies since we don't know when the server response will come back
    if (!cachedResponse.firstRun) {
      // normalize the cachedResponse so we can add dependencies and stick it in the store
      const normalizedPartialResponse = normalizeResponse(cachedResponse.data, context);
      addDeps(normalizedPartialResponse, component, key, this.normalizedDeps, this.denormalizedDeps);
    }

    // if we need more data, get it from the server
    if (!cachedResponse.isComplete) {
      // given an operation enhanced with sendToServer flags, print minimal query
      const serverQueryString = (forceFetch || cachedResponse.firstRun) ?
        queryString : printMinimalQuery(context.operation, idFieldName);

      //  async query the server (no need to track the promise it returns, as it will change the redux state)
      this.queryServer(transport, context, serverQueryString, component, key);
    }
    this._prepareMutations(component, cashayDataState.variables[component], options);
    return cachedResponse;
  }

  /**
   * A method used to get missing data from the server.
   * Once the data comes back, it is normalized, old dependencies are removed, new ones are created,
   * and the data that comes back from the server is compared to local data to minimize invalidations
   *
   * @param {function} transport the transport function to send the query + vars to a GraphQL endpoint
   * @param {object} context the context to normalize data, including the requestAST and schema
   * @param {string} minimizedQueryString the query string to send to the GraphQL endpoint
   * @param {string} component an ID specific to the queryString/variable combo (defaults to the queryString)
   *
   * @return {undefined}
   */
  async queryServer(transport, context, minimizedQueryString, component, key) {
    const {variables} = context;
    // send minimizedQueryString to server and await minimizedQueryResponse
    const serverResponse = await transport(minimizedQueryString, variables);

    const cachedQuery = this.cachedQueries[component];
    // handle errors coming back from the server
    if (serverResponse.errors) {
      console.log(serverResponse.errors);
      cachedQuery.error = serverResponse.errors;
      // TODO put error in redux state
      return;
    }
    //re-create the denormalizedPartialResponse because it went stale when we called the server
    rebuildOriginalArgs(context.operation);
    const {data: denormalizedLocalResponse} = denormalizeStore(context);
    const normalizedLocalResponse = normalizeResponse(denormalizedLocalResponse, context);

    // normalize response to get ready to dispatch it into the state tree
    const normalizedServerResponse = normalizeResponse(serverResponse.data, context);

    // now, remove the objects that look identical to the ones already in the state
    // if the incoming entity (eg Person.123) looks exactly like the one already in the store, then
    // we don't have to invalidate and rerender
    const normalizedServerResponseForStore = shortenNormalizedResponse(normalizedServerResponse, this.getState().data);

    // if the server didn't give us any new stuff, we already set the vars, so we're done here
    if (!normalizedServerResponseForStore) return;
    // combine the partial response with the server response to fully respond to the query
    const fullNormalizedResponse = mergeStores(normalizedLocalResponse, normalizedServerResponse);

    // it's possible that we adjusted the arguments for the operation we sent to server
    // for example, instead of asking for 20 docs, we asked for 5 at index 15.
    // now, we want to ask for the 20 again
    rebuildOriginalArgs(context.operation);

    // read from a pseudo store (eliminates a requery)
    // even if the requery wasn't expensive, doing it here means we don't have to keep track of the fetching status
    // eg if fetching is true, then we always return the cached result
    const reducedContext = Object.assign(context, {cashayDataState: fullNormalizedResponse});
    cachedQuery.createResponse(reducedContext, component, key, this.store.dispatch);

    // add denormalizedDeps so we can invalidate when other queries come in
    // add normalizedDeps to find those deps when a denormalizedReponse is mutated
    // the data fetched from server is only part of the story, so we need the full normalized response
    addDeps(fullNormalizedResponse, component, key, this.normalizedDeps, this.denormalizedDeps);
    // remove the responses from this.cachedQueries where necessary
    flushDependencies(normalizedServerResponseForStore.entities, component, key, this.denormalizedDeps, this.cachedQueries);
    // stick normalize data in store and recreate any invalidated denormalized structures
    this.store.dispatch({
      type: INSERT_NORMALIZED,
      payload: {
        response: normalizedServerResponseForStore,
        component,
        key,
        variables
      }
    });
  }

  _prepareMutations(component, componentStateVars, {mutationHandlers, customMutations}) {
    const {mutationSchema} = this.schema;
    if (isObject(mutationHandlers)) {
      const mutationHandlerNames = Object.keys(mutationHandlers);
      for (let mutationName of mutationHandlerNames) {
        checkMutationInSchema(mutationSchema, mutationName);
        this.mutationHandlers[mutationName] = this.mutationHandlers[mutationName] || {};
        this.mutationHandlers[mutationName][component] = mutationHandlers[mutationName];
      }
    }
    if (isObject(customMutations)) {
      const mutationNames = Object.keys(customMutations);
      for (let mutationName of mutationNames) {
        checkMutationInSchema(mutationSchema, mutationName);
        this.cachedMutations[mutationName] = this.cachedMutations[mutationName] || new CachedMutation();
        const cachedSingles = this.cachedMutations[mutationName].singles;
        if (!cachedSingles[component]) {
          const mutationAST = parse(customMutations[mutationName]);
          const {namespaceAST, variableEnhancers} = namespaceMutation(mutationAST, component, componentStateVars, this.schema);
          cachedSingles[component] = {
            ast: namespaceAST,
            variableEnhancers
          }
        }
      }
    }
  }

  /**
   *
   * A mutationName is not unique to a mutation, but a name + possibleComponentsObj is
   *
   */
  mutate(mutationName, options = {}) {
    const {variables, components: possibleComponentsObj} = options;
    this.cachedMutations[mutationName] = this.cachedMutations[mutationName] || new CachedMutation();
    const cachedMutation = this.cachedMutations[mutationName];
    const {fullMutation, activeComponentsObj, singles} = cachedMutation;
    let mutationString;
    if (fullMutation) {
      const objToCheck = possibleComponentsObj || makeComponentsToUpdate(mutationName, possibleComponentsObj, this.cachedQueries, this.mutationHandlers);
      if (objToCheck === activeComponentsObj) {
        mutationString = fullMutation;
      } else if (equalObjectKeys(objToCheck, activeComponentsObj)) {
        mutationString = fullMutation;
      }
    }
    if (!mutationString) {
      const componentsToUpdateObj = makeComponentsToUpdate(mutationName, possibleComponentsObj, this.cachedQueries, this.mutationHandlers);
      const componentsToUpdateKeys = Object.keys(componentsToUpdateObj);
      cachedMutation.activeComponentsObj = componentsToUpdateObj;

      if (componentsToUpdateKeys.length === 0) {
        // for analytics or mutations that dont affect the client
        mutationString = cachedMutation.fullMutation = print(new MutationShell(mutationName, null, null, true));
      } else {
        // load the cachedMutation.singles with a bespoke (or user-defined) namespaced mutation for each query
        // TODO handle performance boost if only 1 componentIdToUpdate
        this._createMutationsFromQueries(componentsToUpdateKeys, mutationName, variables);

        const cachedSingles = [];
        for (let i = 0; i < componentsToUpdateKeys.length; i++) {
          const component = componentsToUpdateKeys[i];
          const {ast, variableEnhancers} = singles[component];
          cachedSingles.push(ast);
          cachedMutation.variableEnhancers.push(...variableEnhancers);
        }
        mutationString = cachedMutation.fullMutation = mergeMutations(cachedSingles);
      }
    }
    const namespacedVariables = cachedMutation.variableEnhancers.reduce((enhancer, reduction) => enhancer(reduction), variables);
    const newOptions = Object.assign({}, options, {variables: namespacedVariables});

    // optimistcally update
    this._processMutationHandlers(mutationName, cachedMutation.activeComponentsObj, null, variables);

    // async call the server
    this._mutateServer(mutationName, cachedMutation.activeComponentsObj, mutationString, newOptions);
  }

  _createMutationsFromQueries(componentsToUpdateKeys, mutationName, variables) {
    const cachedSingles = this.cachedMutations[mutationName].singles;
    for (let i = 0; i < componentsToUpdateKeys.length; i++) {
      const component = componentsToUpdateKeys[i];
      if (!cachedSingles[component]) {
        const {ast} = this.cachedQueries[component];
        const mutationAST = createMutationFromQuery(ast, mutationName, variables, this.schema);
        const componentStateVars = this.getState().data.variables[component];
        const {namespaceAST, variableEnhancers} = namespaceMutation(mutationAST, component, componentStateVars, this.schema);
        cachedSingles[component] = {
          ast: namespaceAST,
          variableEnhancers
        }
      }
    }
  };

  async _mutateServer(mutationName, componentsToUpdateObj, mutationString, options) {
    const {variables} = options;
    const transport = options.transport || this.transport;
    const docFromServer = await transport(mutationString, variables);
    // update state with new doc from server
    this._processMutationHandlers(mutationName, componentsToUpdateObj, docFromServer.data);
  }

  _processMutationHandlers(mutationName, componentsToUpdateObj, dataFromServer, variables) {
    const componentHandlers = this.mutationHandlers[mutationName];
    const cashayDataState = this.getState().data;
    let allNormalizedChanges = {};
    const componentsToUpdateKeys = Object.keys(componentsToUpdateObj);
    // for every component that listens the the mutationName
    for (let i = 0; i < componentsToUpdateKeys.length; i++) {
      const component = componentsToUpdateKeys[i];
      const key = componentsToUpdateObj[component] === true ? undefined : componentsToUpdateObj[component];
      const componentHandler = componentHandlers[component];

      // find current cached result for this particular component
      const cachedResult = this.cachedQueries[component];

      const {ast, refetch, response} = cachedResult;
      const cachedResponseData = key ? response[key].data : response.data;
      let modifiedResponse;
      // for the denormalized response, mutate it in place or return undefined if no mutation was made
      if (dataFromServer) {
        // if it's from the server, send the doc we got back
        const normalizedDataFromServer = removeNamespacing(dataFromServer, component);
        modifiedResponse = componentHandler(null, normalizedDataFromServer, cachedResponseData, cashayDataState, this._invalidate);
      } else {
        // otherwise, treat it as an optimistic update
        modifiedResponse = componentHandler(variables, null, cachedResponseData, cashayDataState, this._invalidate);
      }

      // there's a possible 3 updates: optimistic, doc from server, full array from server (invalidated)
      if (this._willInvalidateListener) {
        this._willInvalidateListener = false;
        refetch(key);
      }

      // this must come back after the invalidateListener check because they could invalidate without returning something
      if (!modifiedResponse) {
        continue;
      }

      // create a new object to make sure react-redux's updateStatePropsIfNeeded returns true
      if (key) {
        this.cachedQueries[component].response[key] = {...this.cachedQueries[component].response[key]};
      } else {
        this.cachedQueries[component].response = {...this.cachedQueries[component].response}
      }
      const {schema, paginationWords, idFieldName} = this;
      const stateVars = key ? cashayDataState.variables[component][key] : cashayDataState.variables[component];
      const context = buildExecutionContext(ast, {
        variables: stateVars,
        paginationWords,
        idFieldName,
        schema,
        cashayDataState
      });

      const normalizedModifiedResponse = normalizeResponse(modifiedResponse, context);
      allNormalizedChanges = mergeStores(allNormalizedChanges, normalizedModifiedResponse);
    }

    const normalizedServerResponseForStore = shortenNormalizedResponse(allNormalizedChanges, cashayDataState);
    // merge the normalized optimistic result with the state
    // dont invalidate other queries, they might not want it.
    // if they want it, they'll ask for it in their own listener
    if (normalizedServerResponseForStore) {
      this.store.dispatch({
        type: '@@cashay/INSERT_NORMALIZED',
        payload: {
          response: normalizedServerResponseForStore
        }
      });
    }
  }
}
